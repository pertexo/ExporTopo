/*!
 * ExporTopo — fenêtre de prévisualisation 2D (plan) et 3D (terrain), avec choix des calques avant l'export final.
 * Licence MIT.
 */
(function () {
  'use strict';
  const T = window.TopoCore;

  const $ = (id) => document.getElementById(id);
  const cssVar = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);

  /* ------------------------------------------------------------------ */
  /* Utilitaires géométriques                                            */
  /* ------------------------------------------------------------------ */
  function eachPart(geom, fn) {
    if (!geom) return;
    const t = geom.type, c = geom.coordinates;
    if (t === 'Polygon') c.forEach((r) => fn(r, true));
    else if (t === 'MultiPolygon') c.forEach((p) => p.forEach((r) => fn(r, true)));
    else if (t === 'LineString') fn(c, false);
    else if (t === 'MultiLineString') c.forEach((l) => fn(l, false));
    else if (t === 'Point') fn([c], false);
    else if (t === 'MultiPoint') c.forEach((p) => fn([p], false));
  }

  function outerRings(geom) {
    if (!geom) return [];
    if (geom.type === 'Polygon') return [geom.coordinates];
    if (geom.type === 'MultiPolygon') return geom.coordinates;
    return [];
  }

  /** Ombrage + teinte hypsométrique d'une grille, dans un canvas (1 pixel = 1 maille). */
  function reliefCanvas(g, zmin, zmax) {
    const f = Math.max(1, Math.ceil(Math.max(g.w, g.h) / 1600));
    const gg = f > 1 ? T.downsample(g, f) : g;
    const cv = document.createElement('canvas');
    cv.width = gg.w; cv.height = gg.h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(gg.w, gg.h);
    const d = gg.data, w = gg.w, h = gg.h, r = gg.res;
    const span = Math.max(0.5, zmax - zmin);
    const az = (315 * Math.PI) / 180, alt = (45 * Math.PI) / 180;
    const stops = [[0, [74, 122, 84]], [0.35, [150, 170, 104]], [0.65, [205, 180, 120]], [1, [168, 120, 86]]];
    const ramp = (t) => {
      for (let k = 1; k < stops.length; k++) {
        if (t <= stops[k][0]) {
          const a = stops[k - 1], b = stops[k], u = (t - a[0]) / (b[0] - a[0]);
          return [a[1][0] + u * (b[1][0] - a[1][0]), a[1][1] + u * (b[1][1] - a[1][1]), a[1][2] + u * (b[1][2] - a[1][2])];
        }
      }
      return stops[stops.length - 1][1];
    };
    const at = (c, rr) => {
      c = c < 0 ? 0 : c >= w ? w - 1 : c; rr = rr < 0 ? 0 : rr >= h ? h - 1 : rr;
      return d[rr * w + c];
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, z = d[i], o = i * 4;
        if (!T.isValid(z)) { img.data[o + 3] = 0; continue; }
        let zl = at(x - 1, y), zr = at(x + 1, y), zu = at(x, y - 1), zd = at(x, y + 1);
        if (!T.isValid(zl)) zl = z; if (!T.isValid(zr)) zr = z; if (!T.isValid(zu)) zu = z; if (!T.isValid(zd)) zd = z;
        const dzdx = (zr - zl) / (2 * r), dzdy = (zd - zu) / (2 * r);
        const slope = Math.atan(Math.hypot(dzdx, dzdy)), aspect = Math.atan2(dzdy, -dzdx);
        let hs = Math.cos(alt) * Math.cos(slope) + Math.sin(alt) * Math.sin(slope) * Math.cos(az - aspect);
        hs = 0.45 + 0.55 * Math.max(0, hs);
        const col = ramp(Math.min(1, Math.max(0, (z - zmin) / span)));
        img.data[o] = col[0] * hs; img.data[o + 1] = col[1] * hs; img.data[o + 2] = col[2] * hs; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return { canvas: cv, xmin: gg.xmin, ymax: gg.ymax, wm: gg.w * gg.res, hm: gg.h * gg.res };
  }

  /* ------------------------------------------------------------------ */
  /* Vue 2D                                                              */
  /* ------------------------------------------------------------------ */
  function Plan2D(host, ds, layers, readout) {
    this.host = host; this.ds = ds; this.layers = layers; this.readout = readout;
    const bb = T.ringBBox(ds.ring, ds.opt.margin);
    this.ox = (bb[0] + bb[2]) / 2; this.oy = (bb[1] + bb[3]) / 2;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pv-canvas';
    host.append(this.canvas);
    this.paths = {};
    this.build();
    this.relief = ds.grid ? reliefCanvas(ds.grid, ds.stats.zmin, ds.stats.zmax) : null;
    this.buildPlan();
    this.fit();
    this.bind();
  }

  Plan2D.prototype.build = function () {
    const ox = this.ox, oy = this.oy, ds = this.ds;
    const linePath = (feats, closedOnly) => {
      const p = new Path2D();
      for (const f of feats || []) {
        eachPart(f.geometry, (coords, closed) => {
          if (coords.length < 2 || (closedOnly && !closed)) return;
          p.moveTo(coords[0][0] - ox, coords[0][1] - oy);
          for (let k = 1; k < coords.length; k++) p.lineTo(coords[k][0] - ox, coords[k][1] - oy);
          if (closed) p.closePath();
        });
      }
      return p;
    };
    const v = ds.vectors;
    const P = this.paths;
    P.parcelles = linePath(v.parcelles); P.projet = linePath(v.projet); P.cadBati = linePath(v.cadBati);
    P.bati = linePath(v.bati); P.routes = linePath(v.routes); P.hydro = linePath(v.hydro); P.hydroS = linePath(v.hydroS);
    P.fer = linePath(v.fer); P.vege = linePath(v.vege);
    // Courbes
    P.cNorm = new Path2D(); P.cMaster = new Path2D();
    for (const c of ds.view.lines || []) {
      const p = c.master ? P.cMaster : P.cNorm;
      p.moveTo(c.coords[0][0] - ox, c.coords[0][1] - oy);
      for (let k = 1; k < c.coords.length; k++) p.lineTo(c.coords[k][0] - ox, c.coords[k][1] - oy);
      if (c.closed) p.closePath();
    }
    // TIN
    P.tin = new Path2D();
    const F2 = ds.view.faces;
    if (F2 && F2.length / 3 <= 150000) {
      const pts = ds.view.semis.points;
      for (let i = 0; i < F2.length; i += 3) {
        const a = pts[F2[i]], b = pts[F2[i + 1]], c = pts[F2[i + 2]];
        P.tin.moveTo(a.x - ox, a.y - oy); P.tin.lineTo(b.x - ox, b.y - oy); P.tin.lineTo(c.x - ox, c.y - oy); P.tin.closePath();
      }
    }
    // Emprise
    P.emprise = new Path2D();
    ds.ring.forEach((p, k) => (k ? P.emprise.lineTo(p[0] - ox, p[1] - oy) : P.emprise.moveTo(p[0] - ox, p[1] - oy)));
    P.emprise.closePath();
    // Libellés des parcelles
    this.parcelLabels = [];
    for (const f of v.parcelles || []) {
      const p = f.properties || {};
      const rings = outerRings(f.geometry);
      if (!rings.length) continue;
      const lp = T.labelPoint(rings[0][0].slice(0, -1));
      this.parcelLabels.push([lp[0] - ox, lp[1] - oy, (String(p.section || '').replace(/^0+/, '') + ' ' + String(p.numero || '').replace(/^0+/, '')).trim()]);
    }
  };

  /** Tracés du plan TN détaillé (reconstruits après chaque suppression). */
  Plan2D.prototype.buildPlan = function () {
    const ds = this.ds, ox = this.ox, oy = this.oy;
    const PP = this.pp = {};
    if (!ds.plan) return;
    const path = (k) => (PP[k] = PP[k] || new Path2D());
    const line = (p, coords, closed) => {
      if (!coords || coords.length < 2) return;
      p.moveTo(coords[0][0] - ox, coords[0][1] - oy);
      for (let i = 1; i < coords.length; i++) p.lineTo(coords[i][0] - ox, coords[i][1] - oy);
      if (closed) p.closePath();
    };
    for (const it of ds.plan.items) {
      if (it.deleted) continue;
      switch (it.kind) {
        case 'talus':
          for (const l of it.lines) line(path(l.type === 'crete' ? 'talusCrete' : 'talusPied'), l.coords);
          for (const b of it.barbules) line(path('talusBarb'), b);
          break;
        case 'fosse': line(path('fosses'), it.coords); break;
        case 'crete': line(path('cretes'), it.coords); break;
        case 'haie': for (const q of it.paths) line(path(it.source === 'ign' ? 'haiesIgn' : 'haies'), q); break;
        case 'massif': for (const r of it.rings) line(path('massifs'), r, true); break;
        case 'mur': line(path('murs'), it.coords); break;
        case 'constr': line(path('constr'), it.coords); break;
        case 'arbre': { const p = path('arbres'); p.moveTo(it.x - ox + it.d / 2, it.y - oy); p.arc(it.x - ox, it.y - oy, it.d / 2, 0, Math.PI * 2); break; }
        case 'surface': { const p = path('s_' + it.cls); for (const r of it.rings) line(p, r, true); break; }
        case 'changement': if (it.ring) line(path('chg'), it.ring, true); break;
      }
    }
  };

  Plan2D.prototype.fit = function () {
    const bb = T.ringBBox(this.ds.ring, this.ds.opt.margin + 5);
    this.resize();
    this.cx = 0; this.cy = 0;
    this.s = Math.min(this.W / (bb[2] - bb[0]), this.H / (bb[3] - bb[1])) * 0.92;
    this.draw();
  };

  Plan2D.prototype.resize = function () {
    const r = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.W = Math.max(50, r.width); this.H = Math.max(50, r.height); this.dpr = dpr;
    this.canvas.width = Math.round(this.W * dpr); this.canvas.height = Math.round(this.H * dpr);
    this.canvas.style.width = this.W + 'px'; this.canvas.style.height = this.H + 'px';
  };

  Plan2D.prototype.toWorld = function (sx, sy) {
    return [(sx - this.W / 2) / this.s + this.cx, (this.H / 2 - sy) / this.s + this.cy];
  };

  Plan2D.prototype.bind = function () {
    const cv = this.canvas;
    let drag = null;
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const before = this.toWorld(sx, sy);
      const k = Math.exp(-e.deltaY * 0.0015);
      this.s = Math.min(400, Math.max(0.02, this.s * k));
      const after = this.toWorld(sx, sy);
      this.cx += before[0] - after[0]; this.cy += before[1] - after[1];
      this.queue();
    }, { passive: false });
    const pointers = new Map();
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, s: this.s, d: null };
      if (pointers.size === 2) {
        const [a, b] = Array.from(pointers.values());
        drag.d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      }
    });
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      const w = this.toWorld(e.clientX - r.left, e.clientY - r.top);
      this.showReadout(w);
      if (!drag && this.ds.plan) {
        const it = this.pick(w);
        if (it !== this.hover) { this.hover = it; cv.style.cursor = it ? 'pointer' : ''; this.queue(); }
        if (it) this.readout('Clic pour retirer : ' + describe(it));
      }
      if (!drag) return;
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 2 && drag.d) {
        const [a, b] = Array.from(pointers.values());
        this.s = Math.min(400, Math.max(0.02, drag.s * Math.hypot(a[0] - b[0], a[1] - b[1]) / drag.d));
      } else {
        this.cx = drag.cx - (e.clientX - drag.x) / this.s;
        this.cy = drag.cy + (e.clientY - drag.y) / this.s;
      }
      this.queue();
    });
    const end = (e) => {
      if (drag && pointers.size === 1 && e.type === 'pointerup' && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5 && this.ds.plan) {
        const r = cv.getBoundingClientRect();
        const it = this.pick(this.toWorld(e.clientX - r.left, e.clientY - r.top));
        if (it) { it.deleted = true; this.hover = null; cv.style.cursor = ''; this.buildPlan(); this.draw(); if (this.onDelete) this.onDelete(it); }
      }
      pointers.delete(e.pointerId); if (!pointers.size) drag = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('dblclick', () => { if (!this.ds.plan) this.fit(); });
    this.ro = new ResizeObserver(() => { this.resize(); this.draw(); });
    this.ro.observe(this.host);
  };

  /** Élément du plan détaillé sous le pointeur (coordonnées locales). */
  Plan2D.prototype.pick = function (w) {
    const lay = this.layers;
    return TopoPlan.hitTest(this.ds.plan, w[0] + this.ox, w[1] + this.oy, 8 / this.s, (k) => lay[k] && lay[k].on && lay[k].available);
  };

  function describe(it) {
    let s = describeKind(it);
    if (it.conf && window.TopoSurf) s += ' · ' + TopoSurf.CONF_TXT[it.conf] + (it.confWhy && it.conf !== 'bonne' ? ' (' + it.confWhy + ')' : '');
    return s;
  }
  function describeKind(it) {
    if (window.TopoSurf && (it.kind === 'surface' || it.kind === 'changement')) return TopoSurf.describe(it);
    switch (it.kind) {
      case 'arbre': return 'arbre, h ' + it.h.toFixed(1) + ' m, houppier Ø ' + it.d.toFixed(1) + ' m';
      case 'talus': return 'talus' + (it.h > 0 ? ' de ' + it.h.toFixed(2) + ' m' : '');
      case 'fosse': return 'fossé ou noue de ' + it.len.toFixed(0) + ' m';
      case 'crete': return 'ligne de crête';
      case 'extreme': return (it.type === 'haut' ? 'point haut ' : 'point bas ') + it.z.toFixed(2);
      case 'haie': return 'haie' + (it.source === 'ign' ? ' (IGN)' : '');
      case 'massif': return 'massif boisé';
      case 'mur': return 'mur ou clôture, h ' + it.h.toFixed(1) + ' m';
      case 'constr': return it.nature;
      case 'batiment': return 'cotes du bâtiment';
    }
    return it.kind;
  }

  Plan2D.prototype.showReadout = function (w) {
    const X = w[0] + this.ox, Y = w[1] + this.oy;
    const z = this.ds.grid ? T.sample(this.ds.grid, X, Y) : NaN;
    this.readout('X ' + X.toFixed(2) + '   Y ' + Y.toFixed(2) + (isFinite(z) ? '   Z ' + z.toFixed(2) + ' m' : ''));
  };

  Plan2D.prototype.queue = function () {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  };

  Plan2D.prototype.draw = function () {
    const ctx = this.canvas.getContext('2d');
    const on = (k) => this.layers[k] && this.layers[k].on && this.layers[k].available;
    const dpr = this.dpr, s = this.s;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cssVar('--pv-bg', '#e9ebe6');
    ctx.fillRect(0, 0, this.W, this.H);
    // Monde -> écran
    const M = [s * dpr, 0, 0, -s * dpr, (this.W / 2 - this.cx * s) * dpr, (this.H / 2 + this.cy * s) * dpr];
    ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    const lw = (px) => px / s;
    const drawImg = (im, alpha) => {
      ctx.save();
      ctx.globalAlpha = alpha || 1;
      ctx.translate(im.xmin - this.ox, im.ymax - this.oy);
      ctx.scale(1, -1);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(im.canvas, 0, 0, im.wm, im.hm);
      ctx.restore();
    };
    if (this.relief) drawImg(this.relief, 1);
    if (on('ortho') && this.ds.ortho) drawImg({ canvas: this.ds.ortho.canvas, xmin: this.ds.ortho.xmin, ymax: this.ds.ortho.ymax, wm: this.ds.ortho.w * this.ds.ortho.res, hm: this.ds.ortho.h * this.ds.ortho.res }, 1);

    const fillStroke = (path, fill, stroke, px) => {
      if (fill) { ctx.fillStyle = fill; ctx.fill(path, 'evenodd'); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw(px); ctx.stroke(path); }
    };
    const P = this.paths, C = (k) => this.layers[k].color;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (on('vege')) fillStroke(P.vege, 'rgba(70,140,70,.22)', C('vege'), 0.8);
    if (on('hydro')) { fillStroke(P.hydroS, 'rgba(60,130,200,.35)', null); fillStroke(P.hydro, null, C('hydro'), 1.6); }
    // Surfaces d'après l'orthophoto, sous les courbes et les objets du plan détaillé
    const PS = this.pp || {};
    if (this.ds.plan && this.ds.plan.surf && window.TopoSurf) {
      const I = TopoSurf.INFO;
      for (const cls of TopoSurf.ORDER) {
        const p = PS['s_' + cls];
        if (!p || !on(I[cls].key)) continue;
        ctx.globalAlpha = on('ortho') ? 0.32 : 0.55;
        ctx.fillStyle = I[cls].color; ctx.fill(p, 'evenodd');
        ctx.globalAlpha = 1;
        ctx.strokeStyle = I[cls].color; ctx.lineWidth = lw(1.3); ctx.stroke(p);
      }
    }
    if (on('tin') && s > 2) fillStroke(P.tin, null, 'rgba(120,120,120,.45)', 0.5);
    if (on('contours')) { fillStroke(P.cNorm, null, C('contours'), 0.8); fillStroke(P.cMaster, null, C('contours'), 1.8); }
    if (on('routes')) fillStroke(P.routes, null, C('routes'), 2);
    if (on('fer')) fillStroke(P.fer, null, C('fer'), 2);
    if (on('cadBati')) fillStroke(P.cadBati, 'rgba(110,110,110,.30)', C('cadBati'), 0.8);
    if (on('bati')) fillStroke(P.bati, 'rgba(60,60,70,.35)', C('bati'), 1);
    if (on('parcelles')) fillStroke(P.parcelles, null, C('parcelles'), 1.2);
    if (on('projet')) fillStroke(P.projet, null, C('projet'), 3);

    // Plan TN détaillé
    const PP = this.pp || {};
    if (this.ds.plan) {
      const st = (k, color, px, dash) => { if (!PP[k]) return; ctx.setLineDash(dash ? dash.map(lw) : []); ctx.strokeStyle = color; ctx.lineWidth = lw(px); ctx.stroke(PP[k]); };
      if (on('massifs')) { if (PP.massifs) { ctx.fillStyle = 'rgba(51,105,30,.16)'; ctx.fill(PP.massifs, 'evenodd'); } st('massifs', C('massifs'), 1.4, [6, 4]); }
      if (on('arbres') && PP.arbres) { ctx.fillStyle = 'rgba(46,157,58,.28)'; ctx.fill(PP.arbres); st('arbres', C('arbres'), 1.4); }
      if (on('haies')) { st('haies', C('haies'), 3); st('haiesIgn', C('haies'), 1.6, [5, 3]); }
      if (on('talus')) { st('talusBarb', C('talus'), 0.8); st('talusPied', C('talus'), 1.4); st('talusCrete', C('talus'), 2); }
      if (on('cretes')) st('cretes', C('cretes'), 1.4, [7, 4]);
      if (on('fosses')) st('fosses', C('fosses'), 2.4);
      if (on('murs')) st('murs', C('murs'), 2.6);
      if (on('constructions')) st('constr', C('constructions'), 2, [3, 2]);
      if (on('changements')) st('chg', C('changements'), 2.4, [7, 4]);
      ctx.setLineDash([]);
    }

    // Points
    const pts = this.ds.view.semis ? this.ds.view.semis.points : [];
    const stepPx = this.ds.view.step * s;
    if (on('points') && pts.length && stepPx >= 2.5) {
      ctx.fillStyle = C('points');
      const r = Math.min(3, Math.max(1, stepPx / 8)) / s;
      const vb = this.visibleBox();
      ctx.beginPath();
      for (const p of pts) {
        const x = p.x - this.ox, y = p.y - this.oy;
        if (x < vb[0] || x > vb[2] || y < vb[1] || y > vb[3]) continue;
        ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    // Emprise
    ctx.setLineDash([lw(8), lw(5)]);
    fillStroke(P.emprise, null, cssVar('--zone', '#00B4FF'), 2.6);
    ctx.setLineDash([]);

    // Textes à l'écran
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scr = (x, y) => [(x - this.cx) * s + this.W / 2, this.H / 2 - (y - this.cy) * s];
    ctx.textBaseline = 'middle';
    if (on('parcelles') && s > 0.8) {
      ctx.font = '600 12px "Barlow Condensed", sans-serif';
      ctx.fillStyle = C('parcelles'); ctx.textAlign = 'center';
      for (const [x, y, t] of this.parcelLabels) { const q = scr(x, y); ctx.fillText(t, q[0], q[1]); }
    }
    if (on('points') && on('altText') && pts.length && stepPx >= 34) {
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillStyle = cssVar('--pv-ink', '#1c2229'); ctx.textAlign = 'left';
      const vb = this.visibleBox();
      for (const p of pts) {
        const x = p.x - this.ox, y = p.y - this.oy;
        if (x < vb[0] || x > vb[2] || y < vb[1] || y > vb[3]) continue;
        const q = scr(x, y);
        ctx.fillText(p.z.toFixed(2), q[0] + 4, q[1] - 6);
      }
    }
    // Plan détaillé : symboles et textes à l'écran
    if (this.ds.plan) {
      const items = this.ds.plan.items;
      ctx.font = '500 11px "JetBrains Mono", monospace';
      for (const it of items) {
        if (it.deleted) continue;
        if (it.kind === 'fosse' && it.flow && on('fosses')) {
          const q = TopoPlan.pointAt(it.coords, TopoPlan.polyLength(it.coords) / 2);
          const p = scr(q.x - this.ox, q.y - this.oy), a = Math.atan2(-q.dy * it.flow, q.dx * it.flow);
          ctx.strokeStyle = C('fosses'); ctx.lineWidth = 2; ctx.beginPath();
          ctx.moveTo(p[0] - 9 * Math.cos(a - 0.45), p[1] - 9 * Math.sin(a - 0.45)); ctx.lineTo(p[0], p[1]); ctx.lineTo(p[0] - 9 * Math.cos(a + 0.45), p[1] - 9 * Math.sin(a + 0.45));
          ctx.stroke();
        } else if (it.kind === 'extreme' && on('extremes')) {
          const p = scr(it.x - this.ox, it.y - this.oy), up = it.type === 'haut' ? -1 : 1;
          ctx.fillStyle = C('extremes'); ctx.beginPath();
          ctx.moveTo(p[0], p[1] + up * 6); ctx.lineTo(p[0] - 5, p[1] - up * 4); ctx.lineTo(p[0] + 5, p[1] - up * 4); ctx.closePath(); ctx.fill();
          if (s > 1.5) { ctx.textAlign = 'left'; ctx.fillText((it.type === 'haut' ? 'PH ' : 'PB ') + it.z.toFixed(2), p[0] + 8, p[1]); }
        } else if (it.kind === 'arbre' && on('arbres') && s > 6) {
          const p = scr(it.x - this.ox, it.y - this.oy);
          ctx.fillStyle = cssVar('--pv-ink', '#1c2229'); ctx.textAlign = 'center';
          ctx.fillText('h' + Math.round(it.h) + ' Ø' + Math.round(it.d), p[0], p[1]);
        } else if (it.kind === 'batiment' && on('batCotes') && s > 3) {
          const p = scr(it.x - this.ox, it.y - this.oy);
          ctx.fillStyle = C('batCotes'); ctx.textAlign = 'center';
          it.lines.forEach((t, k) => ctx.fillText(t, p[0], p[1] + (k - (it.lines.length - 1) / 2) * 13));
        } else if (it.kind === 'surface' && on('surfTxt') && on(TopoSurf.INFO[it.cls].key) && it.rad * s > 30) {
          const p = scr(it.lx - this.ox, it.ly - this.oy);
          ctx.textAlign = 'center';
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.fillStyle = '#1c2229';
          ctx.font = '600 12px "Barlow Condensed", sans-serif';
          ctx.strokeText(TopoSurf.INFO[it.cls].label, p[0], p[1] - 7); ctx.fillText(TopoSurf.INFO[it.cls].label, p[0], p[1] - 7);
          ctx.font = '500 11px "JetBrains Mono", monospace';
          const a = TopoSurf.fmtArea(it.area) + ' m²';
          ctx.strokeText(a, p[0], p[1] + 7); ctx.fillText(a, p[0], p[1] + 7);
        } else if (it.kind === 'changement' && on('changements')) {
          const p = scr(it.x - this.ox, it.y - this.oy);
          ctx.fillStyle = C('changements'); ctx.beginPath();
          ctx.moveTo(p[0], p[1] - 9); ctx.lineTo(p[0] - 8, p[1] + 6); ctx.lineTo(p[0] + 8, p[1] + 6); ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '700 11px "Barlow", sans-serif'; ctx.fillText('!', p[0], p[1] + 1);
          ctx.font = '500 11px "JetBrains Mono", monospace';
        }
      }
      // Indice de confiance : pastille verte, orange ou rouge sur chaque objet contrôlé
      if (on('confiance')) {
        for (const it of items) {
          if (it.deleted || !it.conf || !on(TopoPlan.keyOf(it))) continue;
          const a = TopoPlan.anchor(it);
          if (!a) continue;
          const p = scr(a[0] - this.ox, a[1] - this.oy);
          ctx.setLineDash([]);
          if (it.conf === 'faible') {
            ctx.strokeStyle = '#e5262f'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(11, it.kind === 'arbre' ? (it.d / 2) * s + 4 : 0), 0, Math.PI * 2); ctx.stroke();
          }
          ctx.fillStyle = it.conf === 'bonne' ? '#2f9e44' : it.conf === 'moyenne' ? '#f08c00' : '#e5262f';
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(p[0], p[1], it.conf === 'bonne' ? 3.5 : 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
      if (this.hover) {
        const it = this.hover;
        ctx.strokeStyle = '#e5262f'; ctx.lineWidth = 3; ctx.setLineDash([]);
        const hl = (coords, closed) => { ctx.beginPath(); coords.forEach((c, i) => { const p = scr(c[0] - this.ox, c[1] - this.oy); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); if (closed) ctx.closePath(); ctx.stroke(); };
        if (it.kind === 'arbre' || it.kind === 'extreme' || it.kind === 'batiment') {
          const p = scr(it.x - this.ox, it.y - this.oy); ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(8, (it.d || 0) / 2 * s), 0, Math.PI * 2); ctx.stroke();
        } else if (it.kind === 'talus') it.lines.forEach((l) => hl(l.coords));
        else if (it.kind === 'haie') it.paths.forEach((q) => hl(q));
        else if (it.kind === 'massif' || it.kind === 'surface') it.rings.forEach((q) => hl(q, true));
        else if (it.kind === 'changement') { if (it.ring) hl(it.ring, true); else { const p = scr(it.x - this.ox, it.y - this.oy); ctx.beginPath(); ctx.arc(p[0], p[1], 12, 0, Math.PI * 2); ctx.stroke(); } }
        else if (it.coords) hl(it.coords);
      }
    }

    // Barre d'échelle
    const target = 120 / s;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [1, 2, 5, 10].map((m) => m * pow).filter((v) => v <= target).pop() || pow;
    const bx = 16, by = this.H - 18, bw = nice * s;
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(bx - 6, by - 16, bw + 12 + 60, 26);
    ctx.fillStyle = '#1c2229'; ctx.fillRect(bx, by, bw, 3);
    ctx.font = '11px "JetBrains Mono", monospace'; ctx.textAlign = 'left';
    ctx.fillText((nice >= 1 ? nice : nice.toFixed(2)) + ' m', bx + bw + 6, by + 1);
  };

  Plan2D.prototype.visibleBox = function () {
    const a = this.toWorld(0, this.H), b = this.toWorld(this.W, 0);
    return [a[0], a[1], b[0], b[1]];
  };

  Plan2D.prototype.destroy = function () { if (this.ro) this.ro.disconnect(); this.canvas.remove(); };

  /* ------------------------------------------------------------------ */
  /* Vue 3D (three.js)                                                   */
  /* ------------------------------------------------------------------ */
  function Terrain3D(host, ds, layers) {
    this.host = host; this.ds = ds; this.layers = layers;
    if (!window.THREE || !ds.grid) { this.failed = true; return; }
    const g = ds.grid;
    const bb = T.ringBBox(ds.ring, ds.opt.margin);
    this.ox = (bb[0] + bb[2]) / 2; this.oy = (bb[1] + bb[3]) / 2; this.oz = ds.stats.zmin;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    host.append(this.renderer.domElement);
    this.renderer.domElement.className = 'pv-canvas';
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(cssVar('--pv-sky', '#dfe6ea'));
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 50000);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556655, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.7);
    sun.position.set(-1, 1.6, -0.8);
    this.scene.add(sun);
    this.groups = {};

    this.buildTerrain();
    this.buildLayers();

    const ext = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, (ds.stats.zmax - ds.stats.zmin) / 2, 0);
    this.camera.position.set(-ext * 0.55, ext * 0.6 + (ds.stats.zmax - ds.stats.zmin), ext * 0.85);
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = true;
    this.controls.update(); // oriente la caméra vers le terrain dès l'ouverture
    this.controls.addEventListener('change', () => this.render());
    this.home = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.apply();
  }

  Terrain3D.prototype.z = function (x, y) {
    const z = T.sample(this.ds.grid, x, y);
    return T.isValid(z) ? z - this.oz : NaN;
  };

  Terrain3D.prototype.buildTerrain = function () {
    const ds = this.ds, g0 = ds.grid;
    const f = Math.max(1, Math.ceil(Math.max(g0.w, g0.h) / 360));
    const g = f > 1 ? T.downsample(g0, f) : g0;
    const w = g.w, h = g.h;
    const pos = new Float32Array(w * h * 3), uv = new Float32Array(w * h * 2), col = new Float32Array(w * h * 3);
    const span = Math.max(0.5, ds.stats.zmax - ds.stats.zmin);
    const o = ds.ortho;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        const x = g.xmin + (c + 0.5) * g.res, y = g.ymax - (r + 0.5) * g.res;
        let z = g.data[i];
        if (!T.isValid(z)) z = ds.stats.zmin;
        pos[i * 3] = x - this.ox; pos[i * 3 + 1] = z - this.oz; pos[i * 3 + 2] = -(y - this.oy);
        if (o) { uv[i * 2] = (x - o.xmin) / (o.w * o.res); uv[i * 2 + 1] = 1 - (o.ymax - y) / (o.h * o.res); }
        const t = (z - ds.stats.zmin) / span;
        // Teinte hypsométrique sobre : vert de prairie en bas, ocre en haut.
        col[i * 3] = 0.42 + 0.30 * t; col[i * 3 + 1] = 0.52 + 0.08 * (1 - t); col[i * 3 + 2] = 0.36 + 0.06 * t;
      }
    }
    const idx = [];
    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const a = r * w + c, b = a + 1, d = a + w, e = d + 1;
        if (!T.isValid(g.data[a]) || !T.isValid(g.data[b]) || !T.isValid(g.data[d]) || !T.isValid(g.data[e])) continue;
        idx.push(a, d, b, b, d, e);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.matPlain = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    if (o) {
      const tex = new THREE.CanvasTexture(downscaleCanvas(o.canvas, 4096));
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
      this.matOrtho = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
    }
    this.terrain = new THREE.Mesh(geo, this.matPlain);
    this.root.add(this.terrain);
  };

  function downscaleCanvas(cv, max) {
    if (cv.width <= max && cv.height <= max) return cv;
    const k = max / Math.max(cv.width, cv.height);
    const o = document.createElement('canvas');
    o.width = Math.round(cv.width * k); o.height = Math.round(cv.height * k);
    o.getContext('2d').drawImage(cv, 0, 0, o.width, o.height);
    return o;
  }

  Terrain3D.prototype.drapedLines = function (feats, color, lift, closedOnly) {
    const arr = [];
    const step = Math.max(1, this.ds.grid.res * 2);
    // Seuls les morceaux posés sur le MNT sont tracés : rien ne pend hors du terrain.
    const seg = (x0, y0, x1, y1) => {
      const z0 = this.z(x0, y0), z1 = this.z(x1, y1);
      if (!isFinite(z0) || !isFinite(z1)) return;
      arr.push(x0 - this.ox, z0 + lift, -(y0 - this.oy), x1 - this.ox, z1 + lift, -(y1 - this.oy));
    };
    for (const f of feats || []) {
      eachPart(f.geometry, (coords, closed) => {
        if (coords.length < 2 || (closedOnly && !closed)) return;
        for (let k = 0; k + 1 < coords.length; k++) {
          const a = coords[k], b = coords[k + 1];
          const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
          for (let j = 0; j < n; j++) {
            const t0 = j / n, t1 = (j + 1) / n;
            seg(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1);
          }
        }
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(color) }));
  };

  Terrain3D.prototype.buildLayers = function () {
    const ds = this.ds, v = ds.vectors, L = this.layers;
    const add = (key, obj) => { if (!obj) return; this.groups[key] = obj; this.root.add(obj); };
    const lift = Math.max(0.15, ds.grid.res * 0.4);

    // Courbes (altitude propre)
    if (ds.view.lines && ds.view.lines.length) {
      const arr = [], arrM = [];
      for (const c of ds.view.lines) {
        const t = c.master ? arrM : arr;
        for (let k = 0; k + 1 < c.coords.length; k++) {
          const a = c.coords[k], b = c.coords[k + 1];
          t.push(a[0] - this.ox, c.z - this.oz + lift * 0.5, -(a[1] - this.oy), b[0] - this.ox, c.z - this.oz + lift * 0.5, -(b[1] - this.oy));
        }
      }
      const grp = new THREE.Group();
      const mk = (a, op) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(a), 3));
        return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(L.contours.color), transparent: true, opacity: op }));
      };
      grp.add(mk(arr, 0.75), mk(arrM, 1));
      add('contours', grp);
    }
    // Points TN
    if (ds.view.semis && ds.view.semis.points.length) {
      const pts = ds.view.semis.points;
      const every = Math.max(1, Math.ceil(pts.length / 200000));
      const arr = [];
      for (let k = 0; k < pts.length; k += every) arr.push(pts[k].x - this.ox, pts[k].z - this.oz + lift, -(pts[k].y - this.oy));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
      add('points', new THREE.Points(geo, new THREE.PointsMaterial({ color: new THREE.Color(L.points.color), size: 2, sizeAttenuation: false })));
    }
    // TIN en fil de fer
    const F3 = ds.view.faces;
    if (F3 && F3.length / 3 <= 120000) {
      const pts = ds.view.semis.points, arr = [];
      for (let i = 0; i < F3.length; i += 3) {
        const a = pts[F3[i]], b = pts[F3[i + 1]], c = pts[F3[i + 2]];
        const P = (p) => [p.x - this.ox, p.z - this.oz + lift * 0.3, -(p.y - this.oy)];
        arr.push(...P(a), ...P(b), ...P(b), ...P(c), ...P(c), ...P(a));
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
      add('tin', new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x555555, transparent: true, opacity: 0.35 })));
    }
    // Lignes drapées
    const lines = [['parcelles', v.parcelles], ['projet', v.projet], ['cadBati', v.cadBati], ['routes', v.routes], ['fer', v.fer], ['vege', v.vege]];
    for (const [k, feats] of lines) if (feats && feats.length) add(k, this.drapedLines(feats, L[k].color, lift));
    if ((v.hydro && v.hydro.length) || (v.hydroS && v.hydroS.length)) {
      const grp = new THREE.Group();
      if (v.hydro) grp.add(this.drapedLines(v.hydro, L.hydro.color, lift));
      if (v.hydroS) grp.add(this.drapedLines(v.hydroS, L.hydro.color, lift));
      add('hydro', grp);
    }
    // Bâtiments BD TOPO extrudés selon leur hauteur
    if (v.bati && v.bati.length) {
      const grp = new THREE.Group();
      const mat = new THREE.MeshLambertMaterial({ color: 0xd9d4cb });
      const edge = new THREE.LineBasicMaterial({ color: 0x55504a });
      for (const f of v.bati) {
        const hgt = Number(f.properties && f.properties.hauteur) > 0 ? Number(f.properties.hauteur) : 6;
        for (const poly of outerRings(f.geometry)) {
          const ring = poly[0];
          if (!ring || ring.length < 4) continue;
          let base = Infinity;
          for (const p of ring) { const z = this.z(p[0], p[1]); if (isFinite(z) && z < base) base = z; }
          if (!isFinite(base)) base = 0;
          const shape = new THREE.Shape(ring.map((p) => new THREE.Vector2(p[0] - this.ox, p[1] - this.oy)));
          for (let k = 1; k < poly.length; k++) shape.holes.push(new THREE.Path(poly[k].map((p) => new THREE.Vector2(p[0] - this.ox, p[1] - this.oy))));
          const geo = new THREE.ExtrudeGeometry(shape, { depth: hgt, bevelEnabled: false });
          const m = new THREE.Mesh(geo, mat);
          m.rotation.x = -Math.PI / 2;
          m.position.y = base;
          grp.add(m);
          const eg = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), edge);
          eg.rotation.x = -Math.PI / 2; eg.position.y = base;
          grp.add(eg);
        }
      }
      add('bati', grp);
    }
    this.buildPlan();
    // Emprise
    const ring = ds.ring.concat([ds.ring[0]]);
    const emp = this.drapedLines([{ geometry: { type: 'LineString', coordinates: ring } }], cssVar('--zone', '#00B4FF'), lift * 2);
    this.root.add(emp);
  };

  /** Objets 3D du plan détaillé (reconstruits après une suppression). */
  Terrain3D.prototype.buildPlan = function () {
    const ds = this.ds, L = this.layers;
    for (const k of this.planKeys || []) { const g0 = this.groups[k]; if (g0) { this.root.remove(g0); g0.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); delete this.groups[k]; } }
    this.planKeys = [];
    if (!ds.plan) return;
    const lift = Math.max(0.15, ds.grid.res * 0.4);
    const arrs = {};
    const seg3 = (k, coords) => {
      const a = (arrs[k] = arrs[k] || []);
      for (let i = 0; i + 1 < coords.length; i++) {
        const p = coords[i], q = coords[i + 1];
        const zp = isFinite(p[2]) ? p[2] - this.oz : this.z(p[0], p[1]), zq = isFinite(q[2]) ? q[2] - this.oz : this.z(q[0], q[1]);
        if (!isFinite(zp) || !isFinite(zq)) continue;
        a.push(p[0] - this.ox, zp + lift, -(p[1] - this.oy), q[0] - this.ox, zq + lift, -(q[1] - this.oy));
      }
    };
    // Contour 2D posé sur le terrain : côtés redécoupés tous les 2 m.
    const drape = (k, ring) => {
      const out = [];
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        const m = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 2));
        for (let j = 0; j < m; j++) out.push([p[0] + (q[0] - p[0]) * j / m, p[1] + (q[1] - p[1]) * j / m]);
      }
      out.push(out[0]);
      seg3(k, out);
    };
    const trees = [];
    for (const it of ds.plan.items) {
      if (it.deleted) continue;
      switch (it.kind) {
        case 'talus': it.lines.forEach((l) => seg3('talus', l.coords)); it.barbules.forEach((b) => seg3('talus', b)); break;
        case 'fosse': seg3('fosses', it.coords); break;
        case 'crete': seg3('cretes', it.coords); break;
        case 'mur': seg3('murs', it.coords); break;
        case 'constr': seg3('constructions', it.coords); break;
        case 'haie': it.paths.forEach((q) => seg3('haies', q)); break;
        case 'massif': it.rings.forEach((r) => seg3('massifs', r.concat([r[0]]))); break;
        case 'arbre': trees.push(it); break;
        case 'surface': if (window.TopoSurf) it.rings.forEach((r) => drape(TopoSurf.INFO[it.cls].key, r)); break;
        case 'changement': if (it.ring) drape('changements', it.ring); break;
      }
    }
    for (const k in arrs) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arrs[k]), 3));
      const grp = new THREE.Group();
      grp.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(L[k] ? L[k].color : '#888') })));
      this.groups[k] = grp; this.root.add(grp); this.planKeys.push(k);
    }
    if (trees.length && THREE.InstancedMesh) {
      const grp = new THREE.Group();
      const crown = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshLambertMaterial({ color: 0x3f8f3a }), trees.length);
      const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6), new THREE.MeshLambertMaterial({ color: 0x6d4c33 }), trees.length);
      const dm = new THREE.Object3D();
      trees.forEach((t, i) => {
        const R = Math.max(0.6, t.d / 2), ch = Math.min(t.h * 0.75, Math.max(2, 1.6 * R)), base = t.z - this.oz;
        dm.position.set(t.x - this.ox, base + t.h - ch / 2, -(t.y - this.oy)); dm.scale.set(R, ch / 2, R); dm.rotation.set(0, 0, 0); dm.updateMatrix();
        crown.setMatrixAt(i, dm.matrix);
        const th = Math.max(0.5, t.h - ch);
        dm.position.set(t.x - this.ox, base + th / 2, -(t.y - this.oy)); dm.scale.set(0.18, th, 0.18); dm.updateMatrix();
        trunk.setMatrixAt(i, dm.matrix);
      });
      grp.add(crown, trunk);
      this.groups.arbres = grp; this.root.add(grp); this.planKeys.push('arbres');
    }
  };

  Terrain3D.prototype.apply = function () {
    const on = (k) => this.layers[k] && this.layers[k].on && this.layers[k].available;
    for (const k in this.groups) this.groups[k].visible = on(k);
    this.terrain.material = on('ortho') && this.matOrtho ? this.matOrtho : this.matPlain;
    this.render();
  };

  Terrain3D.prototype.setExaggeration = function (e) { this.root.scale.y = e; this.render(); };
  Terrain3D.prototype.reset = function () {
    this.camera.position.copy(this.home.pos); this.controls.target.copy(this.home.target); this.controls.update(); this.render();
  };

  Terrain3D.prototype.resize = function () {
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.render();
  };

  Terrain3D.prototype.render = function () {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.renderer.render(this.scene, this.camera); });
  };

  Terrain3D.prototype.destroy = function () {
    if (this.failed) return;
    this.ro.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
    if (this.matOrtho) { this.matOrtho.map.dispose(); this.matOrtho.dispose(); }
    this.matPlain.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  };

  /* ------------------------------------------------------------------ */
  /* Fenêtre                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * Ouvre la prévisualisation.
   * layers : { cle: { label, color, count, on, available, group, note } }
   * onExport(layers) : appelée par « Exporter la version finale ».
   */
  function open(ds, layers, onExport) {
    const modal = $('preview');
    const list = $('pvLayers');
    const view2d = $('pv2d'), view3d = $('pv3d');
    const readout = (t) => { $('pvReadout').textContent = t; };
    let plan = null, terrain = null, mode = '2d';

    // Liste des calques
    list.innerHTML = '';
    // Bandeau d'aperçu allégé
    if (ds.view && ds.view.light) {
      const b = document.createElement('p'); b.className = 'pv-light';
      b.textContent = 'Aperçu allégé pour rester fluide. L\'export final sera calculé à la précision demandée et peut prendre plus de temps.';
      list.append(b);
    }
    const groups = {}, counters = {}, removed = [];
    let lastGroup = null;
    for (const key in layers) {
      const l = layers[key];
      if (!l.available) continue;
      if (l.group !== lastGroup) {
        const h = document.createElement('label'); h.className = 'pv-group';
        const all = document.createElement('input'); all.type = 'checkbox'; all.className = 'pv-all'; all.id = 'pvall_' + Object.keys(groups).length;
        const t = document.createElement('span'); t.textContent = l.group;
        h.append(all, t);
        list.append(h); lastGroup = l.group;
        groups[l.group] = { all, items: [] };
        const grp = groups[l.group];
        all.onchange = () => { grp.items.forEach(([lk, c]) => { c.checked = all.checked; layers[lk].on = all.checked; }); syncGroups(); refresh(); };
      }
      const lab = document.createElement('label');
      lab.className = 'pv-layer';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = l.on; cb.id = 'pv_' + key;
      cb.onchange = () => { l.on = cb.checked; syncGroups(); refresh(); };
      const sw = document.createElement('i'); sw.style.background = l.color || 'transparent';
      const name = document.createElement('span'); name.textContent = l.label;
      const cnt = document.createElement('em'); cnt.textContent = l.count === undefined || l.count === null ? '' : typeof l.count === 'number' ? l.count.toLocaleString('fr-FR') : String(l.count);
      counters[key] = cnt;
      lab.append(cb, sw, name, cnt);
      if (l.note) { const sm = document.createElement('small'); sm.textContent = l.note; lab.append(sm); }
      list.append(lab);
      groups[l.group].items.push([key, cb]);
    }
    function syncGroups() {
      for (const g in groups) {
        const n = groups[g].items.filter(([, c]) => c.checked).length;
        groups[g].all.checked = n === groups[g].items.length;
        groups[g].all.indeterminate = n > 0 && n < groups[g].items.length;
      }
    }
    syncGroups();
    // Millésimes des données IGN
    if (ds.dates && ds.dates.lines.length) {
      const box = document.createElement('div'); box.className = 'pv-dates';
      const h = document.createElement('p'); h.className = 'pv-dates-title'; h.textContent = 'Dates des données IGN';
      box.append(h);
      const dl = document.createElement('dl');
      for (const l of ds.dates.lines) {
        const dt = document.createElement('dt'); dt.textContent = l.label;
        const dd = document.createElement('dd'); dd.textContent = l.value;
        dl.append(dt, dd);
      }
      box.append(dl);
      list.append(box);
    }

    function refresh() {
      for (const k in counters) if (layers[k].countFn && counters[k].textContent !== '') counters[k].textContent = layers[k].countFn().toLocaleString('fr-FR');
      if (plan) plan.draw();
      if (terrain && !terrain.failed) terrain.apply();
      const n = Object.values(layers).filter((l) => l.available && l.on && l.exported !== false).length;
      $('pvExport').disabled = n === 0;
      $('pvCount').textContent = n + ' calque' + (n > 1 ? 's' : '') + ' à exporter';
    }

    // Bilan des surfaces et répartition des indices de confiance
    let bilanBox = null;
    function renderBilan() {
      if (!window.TopoSurf || !ds.plan || !ds.plan.surf) return;
      const b = TopoSurf.bilan(ds.plan);
      if (!b) return;
      if (!bilanBox) { bilanBox = document.createElement('div'); bilanBox.className = 'pv-bilan'; list.append(bilanBox); }
      bilanBox.innerHTML = '';
      const h = document.createElement('p'); h.className = 'pv-dates-title'; h.textContent = 'Bilan des surfaces · zone d\'étude';
      const tb = document.createElement('table');
      const row = (label, color, a, b2, cls) => {
        const tr = document.createElement('tr'); if (cls) tr.className = cls;
        const t1 = document.createElement('td');
        if (color) { const i = document.createElement('i'); i.style.background = color; t1.append(i); }
        t1.append(label);
        const t2 = document.createElement('td'); t2.textContent = a;
        const t3 = document.createElement('td'); t3.textContent = b2;
        tr.append(t1, t2, t3); tb.append(tr);
      };
      const m2 = (v) => TopoSurf.fmtArea(v) + ' m²';
      const pc = (v) => v.toFixed(1).replace('.', ',') + ' %';
      for (const r of b.rows) row(r.label, r.color, m2(r.area), pc(r.pct));
      row('Imperméabilisé', null, m2(b.imper), pc(b.imperPct), 'sum');
      if (b.cr === b.cr) row('Coef. de ruissellement', null, b.cr.toFixed(2).replace('.', ','), '', '');
      const note = document.createElement('p'); note.textContent = 'Coefficients indicatifs, à adapter à votre note hydraulique. Retirer une surface la passe en « non classé ».';
      bilanBox.append(h, tb, note);
      if (ds.plan.items.some((it) => it.conf)) {
        const cf = document.createElement('div'); cf.className = 'pv-conf';
        for (const [lv, color, txt] of [['bonne', '#2f9e44', 'bonne'], ['moyenne', '#f08c00', 'moyenne'], ['faible', '#e5262f', 'à vérifier']]) {
          const s = document.createElement('span'); const dot = document.createElement('b'); dot.style.background = color;
          s.append(dot, TopoPlan.countConf(ds.plan, lv) + ' ' + txt); cf.append(s);
        }
        bilanBox.append(cf);
      }
    }
    renderBilan();

    function planChanged() {
      for (const k in counters) {
        if (!layers[k].plan || counters[k].textContent === '') continue;
        counters[k].textContent = (layers[k].countFn ? layers[k].countFn() : TopoPlan.count(ds.plan, k)).toLocaleString('fr-FR');
      }
      renderBilan();
      $('pvUndo').hidden = !removed.length;
      $('pvUndo').textContent = 'Rétablir (' + removed.length + ')';
      if (terrain && !terrain.failed) { terrain.buildPlan(); terrain.apply(); }
      if (plan) { plan.buildPlan(); plan.draw(); }
    }
    $('pvUndo').hidden = true;
    $('pvUndo').onclick = () => { const it = removed.pop(); if (it) { it.deleted = false; planChanged(); } };

    function show(m) {
      mode = m;
      $('pvTab2d').setAttribute('aria-selected', m === '2d');
      $('pvTab3d').setAttribute('aria-selected', m === '3d');
      view2d.hidden = m !== '2d'; view3d.hidden = m !== '3d';
      $('pv3dTools').hidden = m !== '3d';
      if (m === '2d') {
        readout(ds.plan ? 'Survolez un élément détecté : un clic le retire de l\'export' : '');
        if (!plan) { plan = new Plan2D(view2d, ds, layers, readout); plan.onDelete = (it) => { removed.push(it); planChanged(); }; } else { plan.resize(); plan.draw(); }
      }
      if (m === '3d') {
        if (!terrain) {
          terrain = new Terrain3D(view3d, ds, layers);
          if (terrain.failed) { view3d.innerHTML = '<p class="pv-msg">La vue 3D n\'est pas disponible (bibliothèque 3D non chargée ou pas de MNT).</p>'; }
        } else if (!terrain.failed) terrain.resize();
        readout('Clic gauche : tourner · Clic droit : déplacer · Molette : zoom');
      }
    }

    $('pvTab2d').onclick = () => show('2d');
    $('pvTab3d').onclick = () => show('3d');
    $('pvFit').onclick = () => { if (mode === '2d' && plan) plan.fit(); if (mode === '3d' && terrain && !terrain.failed) terrain.reset(); };
    $('pvExag').value = '1';
    $('pvExagVal').textContent = '× 1';
    $('pvExag').oninput = (e) => {
      const v = parseFloat(e.target.value);
      $('pvExagVal').textContent = '× ' + v.toLocaleString('fr-FR');
      if (terrain && !terrain.failed) terrain.setExaggeration(v);
    };
    const close = () => {
      modal.hidden = true;
      document.body.classList.remove('pv-open');
      if (plan) plan.destroy();
      if (terrain) terrain.destroy();
      plan = terrain = null;
      view3d.innerHTML = '';
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    $('pvClose').onclick = close;
    $('pvExport').onclick = async () => {
      $('pvExport').disabled = true;
      $('pvStatus').textContent = 'Préparation de l\'archive…';
      try {
        const msg = await onExport(layers, (t) => { $('pvStatus').textContent = t; });
        $('pvStatus').textContent = msg || 'Archive téléchargée.';
      } catch (e) {
        $('pvStatus').textContent = 'Échec : ' + e.message;
      } finally { $('pvExport').disabled = false; }
    };
    $('pvStatus').textContent = '';
    modal.hidden = false;
    document.body.classList.add('pv-open');
    show('2d');
    refresh();
    $('pvTab2d').focus();
  }

  window.TopoPreview = { open };
})();
