/*!
 * ExporTopo — Surfaces du plan détaillé d'après l'orthophoto : espaces verts, chaussées, enrobés,
 * parkings, surfaces perméables, cultures, eau et piscines, avec leur surface en m².
 * Sources : CoSIA (IGN, occupation du sol calculée sur l'orthophoto), orthophoto infrarouge (NDVI),
 * orthophoto couleur, LiDAR HD (hauteur du sursol), BD TOPO (bâti, voirie, eau, parkings) et
 * OpenStreetMap (parkings).
 * Contrôle de cohérence : indice de confiance par objet et changements probables entre la date
 * du vol LiDAR et celle de l'orthophoto.
 * Licence MIT.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'), require('./plan.js'));
  else root.TopoSurf = factory(root.TopoCore, root.TopoPlan);
})(typeof self !== 'undefined' ? self : this, function (T, TP) {
  'use strict';

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const valid = (z) => z === z && z > -1000 && z < 9000;

  /* ------------------------------------------------------------------ */
  /* Nomenclatures                                                       */
  /* ------------------------------------------------------------------ */

  /** Classes brutes, issues de CoSIA ou des indices (infrarouge, couleur, LiDAR). */
  const K = { NONE: 0, BATI: 1, IMPER: 2, PERM: 3, SOLNU: 4, EAU: 5, PISCINE: 6, SERRE: 7, ARBRE: 8, ARBUSTE: 9, HERBE: 10, CULTURE: 11 };

  /** Palette CoSIA (nomenclature FLAIR de l'IGN) : [libellé, couleur, classe brute]. */
  const COSIA = [
    ['Bâtiment', '#db0e9a', K.BATI], ['Zone perméable', '#938e7b', K.PERM], ['Zone imperméable', '#f80c00', K.IMPER],
    ['Sol nu', '#a97101', K.SOLNU], ['Surface eau', '#1553ae', K.EAU], ['Conifère', '#194a26', K.ARBRE],
    ['Feuillu', '#46e483', K.ARBRE], ['Broussaille', '#f3a60d', K.ARBUSTE], ['Vigne', '#660082', K.CULTURE],
    ['Pelouse', '#55ff00', K.HERBE], ['Culture', '#fff30d', K.CULTURE], ['Terre labourée', '#e4df7c', K.CULTURE],
    ['Piscine', '#3de6eb', K.PISCINE], ['Coupe', '#8ab3a0', K.HERBE], ['Mixte', '#6b714f', K.ARBRE],
    ['Ligneux', '#c5dc42', K.ARBUSTE], ['Serre', '#9999ff', K.SERRE],
  ];

  /** Classes du plan (valeurs ≥ 20) ; 1 = bâti, exclu des surfaces. */
  const O = { BATI: 1, CHAUSSEE: 20, ENROBE: 21, PARKING: 22, PERMEABLE: 23, EV: 24, CULTURES: 25, EAU: 26, PISCINE: 27 };
  const CLS = { 20: 'chaussee', 21: 'enrobe', 22: 'parking', 23: 'permeable', 24: 'ev', 25: 'cultures', 26: 'eau', 27: 'piscine' };
  const ORDER = ['chaussee', 'enrobe', 'parking', 'permeable', 'ev', 'cultures', 'eau', 'piscine'];

  /** Calque, couleur, libellés et coefficient de ruissellement indicatif de chaque classe. */
  const INFO = {
    chaussee: { key: 'surfChaussee', label: 'Chaussée', legend: 'Chaussée (largeur BD TOPO)', layer: 'SURF_CHAUSSEE', aci: 8, color: '#5f6368', cr: 0.9, imper: true },
    enrobe: { key: 'surfEnrobe', label: 'Enrobé / béton', legend: 'Enrobé, béton, pavés (imperméable)', layer: 'SURF_ENROBE', aci: 252, color: '#9aa0a6', cr: 0.9, imper: true },
    parking: { key: 'surfParking', label: 'Parking', legend: 'Parking', layer: 'SURF_PARKING', aci: 150, color: '#3f6fd8', cr: 0.9, imper: true },
    permeable: { key: 'surfPermeable', label: 'Stabilisé / gravier / terre', legend: 'Stabilisé, gravier, terre (perméable)', layer: 'SURF_PERMEABLE', aci: 42, color: '#c39a52', cr: 0.4 },
    ev: { key: 'surfEV', label: 'Espace vert', legend: 'Espace vert (pelouse, massif, boisement)', layer: 'SURF_ESPACES_VERTS', aci: 3, color: '#3fa34d', cr: 0.2 },
    cultures: { key: 'surfCultures', label: 'Culture', legend: 'Culture, vigne', layer: 'SURF_CULTURES', aci: 52, color: '#c9b52c', cr: 0.2 },
    eau: { key: 'surfEau', label: 'Eau', legend: 'Eau, piscine', layer: 'SURF_EAU', aci: 4, color: '#1e88e5', cr: 1 },
    piscine: { key: 'surfEau', label: 'Piscine', legend: 'Eau, piscine', layer: 'SURF_EAU', aci: 4, color: '#26c6da', cr: 1 },
  };
  const RAW2OUT = new Uint8Array(16);
  RAW2OUT[K.BATI] = O.BATI; RAW2OUT[K.SERRE] = O.BATI; RAW2OUT[K.IMPER] = O.ENROBE; RAW2OUT[K.PERM] = O.PERMEABLE; RAW2OUT[K.SOLNU] = O.PERMEABLE;
  RAW2OUT[K.EAU] = O.EAU; RAW2OUT[K.PISCINE] = O.PISCINE; RAW2OUT[K.ARBRE] = O.EV; RAW2OUT[K.ARBUSTE] = O.EV; RAW2OUT[K.HERBE] = O.EV; RAW2OUT[K.CULTURE] = O.CULTURES;

  /* ------------------------------------------------------------------ */
  /* Décodage de l'image CoSIA                                           */
  /* ------------------------------------------------------------------ */

  let LUT = null;
  /** Table RVB (5 bits par canal) -> classe brute de la couleur CoSIA la plus proche (0 si aucune n'est proche). */
  function lut() {
    if (LUT) return LUT;
    const pal = COSIA.map((p) => [parseInt(p[1].slice(1, 3), 16), parseInt(p[1].slice(3, 5), 16), parseInt(p[1].slice(5, 7), 16), p[2]]);
    const maxD2 = 42 * 42;
    LUT = new Uint8Array(32768);
    for (let r = 0; r < 32; r++) {
      for (let g = 0; g < 32; g++) {
        for (let b = 0; b < 32; b++) {
          const R = r * 8 + 4, G = g * 8 + 4, B = b * 8 + 4;
          let best = 0, bd = maxD2;
          for (const p of pal) { const d = (p[0] - R) * (p[0] - R) + (p[1] - G) * (p[1] - G) + (p[2] - B) * (p[2] - B); if (d < bd) { bd = d; best = p[3]; } }
          LUT[(r << 10) | (g << 5) | b] = best;
        }
      }
    }
    return LUT;
  }

  /** Classes brutes d'une image CoSIA RVBA. `into` : complète un tableau existant (millésime plus ancien). */
  function decodeCosia(rgba, n, into) {
    const L = lut();
    const out = into || new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      if (out[i] || rgba[j + 3] < 128) continue;
      out[i] = L[((rgba[j] >> 3) << 10) | ((rgba[j + 1] >> 3) << 5) | (rgba[j + 2] >> 3)];
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Rastérisation                                                       */
  /* ------------------------------------------------------------------ */

  function polysOf(geom) {
    if (!geom) return [];
    if (geom.type === 'Polygon') return [geom.coordinates];
    if (geom.type === 'MultiPolygon') return geom.coordinates;
    return [];
  }

  /** Appelle fn(i) pour chaque maille dont le centre est dans le polygone (anneaux, règle pair-impair : trous respectés). */
  function fillPoly(g, rings, fn) {
    let y0 = Infinity, y1 = -Infinity;
    for (const r of rings) for (const p of r) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    const r0 = Math.max(0, Math.floor((g.ymax - y1) / g.res - 0.5)), r1 = Math.min(g.h - 1, Math.ceil((g.ymax - y0) / g.res - 0.5));
    const xs = [];
    for (let r = r0; r <= r1; r++) {
      const y = g.ymax - (r + 0.5) * g.res;
      xs.length = 0;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const yi = ring[i][1], yj = ring[j][1];
          if ((yi > y) !== (yj > y)) xs.push(ring[i][0] + ((y - yi) * (ring[j][0] - ring[i][0])) / (yj - yi));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - g.xmin) / g.res - 0.5)), c1 = Math.min(g.w - 1, Math.floor((xs[k + 1] - g.xmin) / g.res - 0.5));
        for (let c = c0; c <= c1; c++) fn(r * g.w + c);
      }
    }
  }

  /** Appelle fn(i) pour chaque maille à moins de hw mètres de la polyligne. */
  function bufferLine(g, coords, hw, fn) {
    const hw2 = hw * hw;
    for (let k = 0; k + 1 < coords.length; k++) {
      const a = coords[k], b = coords[k + 1];
      const c0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - hw - g.xmin) / g.res)), c1 = Math.min(g.w - 1, Math.floor((Math.max(a[0], b[0]) + hw - g.xmin) / g.res));
      const r0 = Math.max(0, Math.floor((g.ymax - Math.max(a[1], b[1]) - hw) / g.res)), r1 = Math.min(g.h - 1, Math.floor((g.ymax - Math.min(a[1], b[1]) + hw) / g.res));
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      for (let r = r0; r <= r1; r++) {
        const y = g.ymax - (r + 0.5) * g.res;
        for (let c = c0; c <= c1; c++) {
          const x = g.xmin + (c + 0.5) * g.res;
          let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = a[0] + t * dx - x, ey = a[1] + t * dy - y;
          if (ex * ex + ey * ey <= hw2) fn(r * g.w + c);
        }
      }
    }
  }

  /** Largeur de chaussée d'un tronçon BD TOPO (attribut, sinon d'après la nature et le nombre de voies). */
  function roadWidth(p) {
    const w = Number(p.largeur_de_chaussee);
    if (w > 0.5 && w < 40) return w;
    const nat = String(p.nature || '');
    if (/autoroutier/i.test(nat)) return 10;
    if (/2 chauss/i.test(nat)) return 12;
    if (/rond-point/i.test(nat)) return 7;
    if (/bretelle/i.test(nat)) return 4;
    const n = Number(p.nombre_de_voies);
    if (n > 0 && n < 10) return n * 3;
    return 5;
  }
  /** Tronçons dont le revêtement n'est pas garanti : pas de chaussée tracée. */
  const NOT_PAVED = /chemin|sentier|empierr|escalier|bac|gu[eé]/i;

  /** Composantes 4-connexes des valeurs ≥ 20 d'un tableau de classes. */
  function components(v, w, h) {
    const n = w * h;
    const lab = new Int32Array(n).fill(-1);
    const comps = [];
    const stack = new Int32Array(n);
    for (let i0 = 0; i0 < n; i0++) {
      const val = v[i0];
      if (val < 20 || lab[i0] >= 0) continue;
      const id = comps.length;
      let sp = 0, cnt = 0, minc = w, maxc = -1, minr = h, maxr = -1;
      stack[sp++] = i0; lab[i0] = id;
      while (sp) {
        const i = stack[--sp];
        cnt++;
        const r = (i / w) | 0, c = i - r * w;
        if (c < minc) minc = c; if (c > maxc) maxc = c; if (r < minr) minr = r; if (r > maxr) maxr = r;
        if (c > 0 && lab[i - 1] < 0 && v[i - 1] === val) { lab[i - 1] = id; stack[sp++] = i - 1; }
        if (c < w - 1 && lab[i + 1] < 0 && v[i + 1] === val) { lab[i + 1] = id; stack[sp++] = i + 1; }
        if (r > 0 && lab[i - w] < 0 && v[i - w] === val) { lab[i - w] = id; stack[sp++] = i - w; }
        if (r < h - 1 && lab[i + w] < 0 && v[i + w] === val) { lab[i + w] = id; stack[sp++] = i + w; }
      }
      comps.push({ id, v: val, n: cnt, minc, maxc, minr, maxr });
    }
    return { lab, comps };
  }

  /** Parcourt les mailles d'une composante. */
  function eachCell(lab, w, cp, fn) {
    for (let r = cp.minr; r <= cp.maxr; r++) {
      for (let c = cp.minc; c <= cp.maxc; c++) { const i = r * w + c; if (lab[i] === cp.id) fn(i, r, c); }
    }
  }

  function signedArea(r) {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
    return a / 2;
  }

  /**
   * Contours d'une composante : [extérieur (sens trigonométrique), trous (sens horaire)…],
   * point d'étiquette le plus éloigné des bords et rayon libre autour.
   */
  function outline(g, lab, cp, opt) {
    const res = g.res, pad = 1;
    const sw = cp.maxc - cp.minc + 1 + 2 * pad, sh = cp.maxr - cp.minr + 1 + 2 * pad;
    const data = new Float32Array(sw * sh);
    eachCell(lab, g.w, cp, (i, r, c) => { data[(r - cp.minr + pad) * sw + (c - cp.minc + pad)] = 1; });
    const sub = { xmin: g.xmin + (cp.minc - pad) * res, ymax: g.ymax - (cp.minr - pad) * res, res, w: sw, h: sh, data };
    let rings = T.contours(sub, 1, { levels: [0.5], simplify: opt.organic ? res * 0.4 : res * 0.55 })
      .filter((l) => l.closed && l.coords.length >= 4)
      .map((l) => T.stripClosing(l.coords.map((p) => [p[0], p[1]])));
    if (opt.organic) rings = rings.map((r) => (r.length >= 4 ? T.simplify(TP.chaikin(r, 1, true), res * 0.12) : r));
    rings = rings.filter((r) => r.length >= 3);
    if (!rings.length) return null;
    rings.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
    const minHole = opt.minHole || 0;
    const outer = signedArea(rings[0]) < 0 ? rings[0].slice().reverse() : rings[0];
    const holes = [];
    for (let k = 1; k < rings.length; k++) {
      const a = signedArea(rings[k]);
      if (Math.abs(a) < minHole) continue;
      holes.push(a > 0 ? rings[k].slice().reverse() : rings[k]);
    }
    // Distance au bord (chanfrein 3-4) : point d'étiquette dans la partie la plus large.
    const dt = new Float32Array(sw * sh);
    for (let r = 0; r < sh; r++) {
      for (let c = 0; c < sw; c++) {
        const i = r * sw + c;
        if (!data[i]) continue;
        let d = 1e9;
        if (c > 0) d = Math.min(d, dt[i - 1] + 3);
        if (r > 0) { d = Math.min(d, dt[i - sw] + 3); if (c > 0) d = Math.min(d, dt[i - sw - 1] + 4); if (c < sw - 1) d = Math.min(d, dt[i - sw + 1] + 4); }
        dt[i] = d;
      }
    }
    let best = -1, bi = 0;
    for (let r = sh - 1; r >= 0; r--) {
      for (let c = sw - 1; c >= 0; c--) {
        const i = r * sw + c;
        if (!data[i]) continue;
        let d = dt[i];
        if (c < sw - 1) d = Math.min(d, dt[i + 1] + 3);
        if (r < sh - 1) { d = Math.min(d, dt[i + sw] + 3); if (c < sw - 1) d = Math.min(d, dt[i + sw + 1] + 4); if (c > 0) d = Math.min(d, dt[i + sw - 1] + 4); }
        dt[i] = d;
        if (d > best) { best = d; bi = i; }
      }
    }
    const lc = bi % sw, lr = (bi - lc) / sw;
    let area = Math.abs(signedArea(outer));
    for (const hr of holes) area -= Math.abs(signedArea(hr));
    return { rings: [outer].concat(holes), area: Math.max(0, area), lx: sub.xmin + (lc + 0.5) * res, ly: sub.ymax - (lr + 0.5) * res, rad: (best / 3) * res };
  }

  const median = (a) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };

  /* ------------------------------------------------------------------ */
  /* Analyse                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * input = {
   *   g: { xmin, ymax, res, w, h }   grille de travail (centres de mailles comme TopoCore),
   *   ring, margin,
   *   cosia: Uint8Array (classes brutes) ou null, cosiaLayer,
   *   irc, rgb: RVBA (Uint8ClampedArray) de l'orthophoto infrarouge (PIR, R, V) et couleur, ou null,
   *   mnt, mns: grilles LiDAR (hauteur du sursol), mns peut être null,
   *   buildings, cadBati, hydroS, routes: features BD TOPO / cadastre,
   *   parkings: [{ geometry, source: 'ign' | 'osm' }],
   *   plan: plan détaillé (objets LiDAR contrôlés),
   *   order: 'ortho' si l'orthophoto est plus récente que le LiDAR, 'lidar' sinon, null si inconnu,
   *   opts: { scale, conf, chang }
   * }
   * Retour : { items (surfaces et changements), info }
   */
  async function analyse(input, progress) {
    progress = progress || (() => {});
    const g = input.g, w = g.w, h = g.h, n = w * h, res = g.res, A = res * res;
    const ring = input.ring, margin = input.margin || 0;
    const opts = input.opts || {};
    const scale = opts.scale || 200;
    const order = input.order || null;

    progress(0.02, 'zone');
    await tick();
    const zin = new Uint8Array(n), zone = new Uint8Array(n);
    fillPoly(g, [ring], (i) => { zin[i] = 1; zone[i] = 1; });
    if (margin > 0) bufferLine(g, ring.concat([ring[0]]), margin, (i) => { zone[i] = 1; });

    // Hauteur du sursol (MNS - MNT)
    const mnh = new Float32Array(n).fill(NaN);
    const hasMnh = !!(input.mnt && input.mns);
    if (hasMnh) {
      const m = input.mnt, s = input.mns;
      const cm = new Int32Array(w), rm = new Int32Array(h);
      for (let c = 0; c < w; c++) cm[c] = Math.floor((g.xmin + (c + 0.5) * res - m.xmin) / m.res);
      for (let r = 0; r < h; r++) rm[r] = Math.floor((m.ymax - (g.ymax - (r + 0.5) * res)) / m.res);
      for (let r = 0; r < h; r++) {
        const rr = rm[r];
        if (rr < 0 || rr >= m.h) continue;
        for (let c = 0; c < w; c++) {
          const cc = cm[c];
          if (cc < 0 || cc >= m.w) continue;
          const k = rr * m.w + cc, a = m.data[k], b = s.data[k];
          if (valid(a) && valid(b)) mnh[r * w + c] = b - a;
        }
      }
    }

    // Indices de végétation : NDVI (infrarouge), excès de vert (couleur)
    const irc = input.irc, rgb = input.rgb;
    const ndvi = irc ? new Float32Array(n) : null, exg = rgb ? new Float32Array(n) : null;
    if (irc) {
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const pir = irc[j], red = irc[j + 1];
        ndvi[i] = irc[j + 3] < 128 || pir + red < 8 || (pir > 250 && red > 250 && irc[j + 2] > 250) ? NaN : (pir - red) / (pir + red);
      }
    }
    if (rgb) {
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const R = rgb[j], G = rgb[j + 1], B = rgb[j + 2], s = R + G + B;
        exg[i] = rgb[j + 3] < 128 || s < 15 || (R > 250 && G > 250 && B > 250) ? NaN : (2 * G - R - B) / s;
      }
    }

    // Classes brutes : CoSIA en priorité, sinon indices
    progress(0.1, 'occupation du sol');
    await tick();
    const cos = input.cosia;
    const C = new Uint8Array(n), src = new Uint8Array(n);
    const classify = (i) => {
      const nd = ndvi ? ndvi[i] : NaN, eg = exg ? exg[i] : NaN, hh = mnh[i];
      let veg, mineral;
      if (nd === nd) { veg = nd > 0.2; mineral = nd < 0.1; } else if (eg === eg) { veg = eg > 0.1; mineral = !veg; } else return K.NONE;
      if (veg) return hh > 2.5 ? K.ARBRE : hh > 0.8 ? K.ARBUSTE : K.HERBE;
      if (!mineral) return K.PERM;
      if (rgb) {
        const j = i * 4, R = rgb[j], G = rgb[j + 1], B = rgb[j + 2];
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B), sat = mx ? (mx - mn) / mx : 0;
        if (sat > 0.22 && R > B + 25) return K.SOLNU;
      }
      return K.IMPER;
    };
    let nZone = 0, nCos = 0;
    for (let i = 0; i < n; i++) {
      if (!zone[i]) continue;
      nZone++;
      if (cos && cos[i]) { C[i] = cos[i]; src[i] = 1; nCos++; continue; }
      const c = classify(i);
      if (c) { C[i] = c; src[i] = 2; }
    }

    // Bâti, eau, chaussées et parkings des bases vectorielles
    progress(0.2, 'bâti, voirie, eau et parkings');
    await tick();
    const bld = new Uint8Array(n), hyd = new Uint8Array(n), road = new Uint8Array(n), park = new Uint8Array(n);
    for (const f of (input.buildings || []).concat(input.cadBati || [])) for (const p of polysOf(f.geometry)) fillPoly(g, p, (i) => { bld[i] = 1; });
    for (const f of input.hydroS || []) for (const p of polysOf(f.geometry)) fillPoly(g, p, (i) => { hyd[i] = 1; });
    for (const f of input.routes || []) {
      const p = f.properties || {};
      const pos = p.position_par_rapport_au_sol;
      if (pos !== undefined && pos !== null && String(pos) !== '0') continue;
      if (NOT_PAVED.test(String(p.nature || ''))) continue;
      if (p.etat_de_l_objet && !/service/i.test(String(p.etat_de_l_objet))) continue;
      const hw = roadWidth(p) / 2;
      T.eachPart(f.geometry, (coords) => { if (coords.length > 1) bufferLine(g, coords, hw, (i) => { road[i] = 1; }); });
    }
    for (const f of input.parkings || []) {
      const v = f.source === 'osm' ? 2 : 1;
      for (const p of polysOf(f.geometry)) fillPoly(g, p, (i) => { park[i] |= v; });
    }

    // Bâtiments BD TOPO contrôlés : hauteur LiDAR et toiture CoSIA sur l'emprise.
    // Absent des deux (démoli) : l'emprise suit l'orthophoto au lieu de rester « bâti ».
    const bdCheck = [], ghost = new Uint8Array(n);
    if (hasMnh) {
      for (const f of input.buildings || []) {
        for (const p of polysOf(f.geometry)) {
          const outer = T.stripClosing(p[0]);
          if (outer.length < 3 || T.ringArea(outer) < 15) continue;
          const lp = T.labelPoint(outer);
          if (!T.inZone(lp[0], lp[1], ring, margin)) continue;
          const hs = [];
          let nb = 0, nc = 0, ncos = 0;
          fillPoly(g, p, (i) => { const hh = mnh[i]; if (hh === hh) hs.push(hh); nc++; if (src[i] === 1) { ncos++; if (C[i] === K.BATI || C[i] === K.SERRE) nb++; } });
          if (hs.length < 8) continue;
          const b = { poly: p, outer, lp, med: median(hs), seen: ncos > nc * 0.5 ? nb / ncos : NaN, area: T.ringArea(outer) };
          bdCheck.push(b);
          if (b.med < 1 && b.seen < 0.4) fillPoly(g, p, (i) => { ghost[i] = 1; });
        }
      }
    }

    // Classes du plan
    const Oc = new Uint8Array(n), forced = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!zone[i]) continue;
      if (bld[i] && !ghost[i]) { Oc[i] = O.BATI; continue; }
      let c = C[i];
      const hh = mnh[i];
      // Bâti CoSIA hors emprise BD TOPO / cadastre : réel si le LiDAR le voit, sinon dévers de toiture sur l'orthophoto.
      if (c === K.BATI || c === K.SERRE) c = hh > 2 || !(hh === hh) ? K.BATI : K.IMPER;
      if (hyd[i] && c !== K.BATI) c = K.EAU;
      let o = RAW2OUT[c];
      const canopy = (c === K.ARBRE || c === K.ARBUSTE) && hh > 2;
      // Sans CoSIA, « perméable » vient d'indices de couleur peu sûrs : la chaussée BD TOPO revêtue l'emporte.
      if (road[i] && (o === O.ENROBE || o === 0 || canopy || (src[i] === 2 && o === O.PERMEABLE))) { o = O.CHAUSSEE; if (canopy) forced[i] = 1; }
      if (park[i] && (o === O.ENROBE || o === O.CHAUSSEE || o === O.PERMEABLE || o === 0 || canopy)) { o = O.PARKING; if (canopy) forced[i] = 1; }
      Oc[i] = o;
    }

    // Mailles sans classe : classe majoritaire des voisines.
    progress(0.35, 'nettoyage');
    await tick();
    const cnt = new Uint32Array(32);
    for (let pass = 0; pass < 4; pass++) {
      const cp = Oc.slice();
      let changed = 0;
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const i = r * w + c;
          if (!zone[i] || cp[i] !== 0) continue;
          cnt.fill(0);
          let best = 0, bn = 0;
          for (let dr = -1; dr <= 1; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= h) continue;
            for (let dc = -1; dc <= 1; dc++) {
              const cc = c + dc;
              if (cc < 0 || cc >= w) continue;
              const v = cp[rr * w + cc];
              if (v >= 20) { const k = ++cnt[v]; if (k > bn) { bn = k; best = v; } }
            }
          }
          if (best) { Oc[i] = best; changed++; }
        }
      }
      if (!changed) break;
    }
    // Lissage majoritaire 3 × 3 : supprime le bruit de classification le long des bords.
    for (let pass = 0; pass < 2; pass++) {
      const cp = Oc.slice();
      for (let r = 1; r < h - 1; r++) {
        for (let c = 1; c < w - 1; c++) {
          const i = r * w + c, v = cp[i];
          if (v < 20 || forced[i]) continue;
          cnt.fill(0);
          let best = 0, bn = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const u = cp[i + dr * w + dc];
              if (u >= 20) { const k = ++cnt[u]; if (k > bn) { bn = k; best = u; } }
            }
          }
          if (cnt[v] <= 3 && bn >= 5 && best !== v) Oc[i] = best;
        }
      }
    }
    // Petites taches fusionnées dans la surface voisine dominante.
    const f200 = scale / 200;
    const base = Math.min(25, Math.max(2, 4 * f200));
    const minArea = (v) => (v === O.PARKING ? Math.max(base, 12) : v === O.PISCINE ? 3 : v === O.EAU ? Math.max(2, base / 2) : v === O.CHAUSSEE ? base * 1.5 : base);
    for (let pass = 0; pass < 3; pass++) {
      const { lab, comps } = components(Oc, w, h);
      let merged = 0;
      for (const cp of comps) {
        if (cp.n * A >= minArea(cp.v)) continue;
        cnt.fill(0);
        eachCell(lab, w, cp, (i, r, c) => {
          const nb = [c > 0 ? i - 1 : -1, c < w - 1 ? i + 1 : -1, r > 0 ? i - w : -1, r < h - 1 ? i + w : -1];
          for (const j of nb) if (j >= 0 && lab[j] !== cp.id && Oc[j] >= 20 && Oc[j] !== cp.v) cnt[Oc[j]]++;
        });
        let best = 0, bn = 0;
        for (let v = 20; v < 28; v++) if (cnt[v] > bn) { bn = cnt[v]; best = v; }
        if (best) { eachCell(lab, w, cp, (i) => { Oc[i] = best; }); merged++; }
      }
      if (!merged) break;
    }

    // Vectorisation, surfaces et indice de confiance
    progress(0.55, 'contours des surfaces');
    await tick();
    const items = [];
    const { lab, comps } = components(Oc, w, h);
    let k0 = 0;
    for (const cp of comps) {
      const cls = CLS[cp.v];
      if (!cls || cp.n * A < minArea(cp.v)) continue;
      if (++k0 % 200 === 0) { progress(0.55 + 0.25 * k0 / comps.length, 'contours des surfaces'); await tick(); }
      const organic = cls === 'ev' || cls === 'cultures' || cls === 'eau' || cls === 'piscine';
      const ol = outline(g, lab, cp, { organic, minHole: Math.max(1, minArea(cp.v) / 2) });
      if (!ol || ol.area < minArea(cp.v) * 0.5) continue;
      let nC = 0, nCue = 0, nOk = 0, nZ = 0, pIgn = 0, pOsm = 0;
      const mineral = cls === 'chaussee' || cls === 'enrobe' || cls === 'parking' || cls === 'permeable';
      eachCell(lab, w, cp, (i) => {
        if (zin[i]) nZ++;
        if (src[i] === 1) nC++;
        if (park[i] & 1) pIgn++;
        if (park[i] & 2) pOsm++;
        if (forced[i]) return;
        const nd = ndvi ? ndvi[i] : NaN, eg = exg ? exg[i] : NaN, hh = mnh[i];
        let ok = null;
        if (cls === 'ev') ok = nd === nd ? nd > 0.12 : eg === eg ? eg > 0.05 : null;
        else if (mineral) {
          const m = nd === nd ? nd < 0.25 : eg === eg ? eg < 0.12 : null;
          ok = m === null ? (hh === hh ? hh < 2.5 : null) : m && !(hh > 2.5);
        } else if (cls === 'eau' || cls === 'piscine') ok = nd === nd ? nd < 0.15 : null;
        if (ok !== null) { nCue++; if (ok) nOk++; }
      });
      const cosFrac = nC / cp.n;
      let conf, why = null;
      if (nCue < 0.3 * cp.n) {
        conf = cosFrac >= 0.8 ? 'bonne' : 'moyenne';
        if (conf === 'moyenne') why = 'une seule source, non recoupée';
      } else {
        const s = nOk / nCue;
        conf = s >= 0.8 ? 'bonne' : s >= 0.55 ? 'moyenne' : 'faible';
        if (conf !== 'bonne') why = cls === 'ev' ? 'végétation peu visible sur l\'orthophoto (travaux, sol nu ?)' : mineral ? 'végétation ou volume visible sur une surface minérale' : 'eau non confirmée par l\'infrarouge';
      }
      if (cosFrac < 0.5 && conf === 'bonne') { conf = 'moyenne'; why = 'classée sans CoSIA (indices infrarouge et couleur)'; }
      const it = { kind: 'surface', cls, rings: ol.rings, area: ol.area, areaZone: nZ * A, lx: ol.lx, ly: ol.ly, rad: ol.rad, conf, confWhy: why, src: cosFrac >= 0.5 ? 'CoSIA' : 'indices' };
      if (cls === 'parking') it.psrc = [pIgn ? 'BD TOPO' : null, pOsm ? 'OpenStreetMap' : null].filter(Boolean).join(' + ') || null;
      items.push(it);
    }

    // Bilan de la zone d'étude
    let nIn = 0, nBati = 0;
    for (let i = 0; i < n; i++) { if (!zin[i]) continue; nIn++; if (Oc[i] === O.BATI) nBati++; }

    // Contrôle des objets détectés au LiDAR (arbres, haies, massifs, murs)
    const cellIdx = (x, y) => { const c = Math.floor((x - g.xmin) / res), r = Math.floor((g.ymax - y) / res); return c < 0 || r < 0 || c >= w || r >= h ? -1 : r * w + c; };
    const treeAt = (i) => (src[i] === 1 ? C[i] === K.ARBRE || C[i] === K.ARBUSTE : ndvi && ndvi[i] === ndvi[i] ? ndvi[i] > 0.2 : exg && exg[i] === exg[i] ? exg[i] > 0.1 : null);
    const vegAt = (i) => (src[i] === 1 ? C[i] === K.ARBRE || C[i] === K.ARBUSTE || C[i] === K.HERBE : treeAt(i));
    const frac = (pts, fn) => {
      let k = 0, v = 0;
      for (const p of pts) { const i = cellIdx(p[0], p[1]); if (i < 0 || !src[i]) continue; const t = fn(i); if (t === null) continue; k++; if (t) v++; }
      return k >= 3 ? v / k : NaN;
    };
    const along = (coords, step) => {
      const out = [], L = TP.polyLength(coords);
      for (let s = 0; s <= L; s += step) { const q = TP.pointAt(coords, s); out.push([q.x, q.y]); }
      return out;
    };
    let nChecked = 0;
    if (opts.conf !== false && input.plan && (cos || ndvi || exg)) {
      for (const it of input.plan.items) {
        let f = NaN;
        if (it.kind === 'arbre') {
          const R = Math.max(0.8, it.d * 0.3), pts = [];
          for (let y = -R; y <= R; y += res) for (let x = -R; x <= R; x += res) if (x * x + y * y <= R * R) pts.push([it.x + x, it.y + y]);
          f = frac(pts, treeAt);
          if (f === f) {
            it.conf = f >= 0.5 ? 'bonne' : f >= 0.25 ? 'moyenne' : 'faible';
            it.confWhy = it.conf === 'faible' ? (order === 'ortho' ? 'houppier absent de l\'orthophoto (abattu depuis le vol LiDAR ?)' : 'houppier absent de l\'orthophoto (objet non végétal ?)')
              : it.conf === 'moyenne' ? 'houppier peu visible sur l\'orthophoto' : null;
          }
        } else if (it.kind === 'haie' && it.source === 'lidar') {
          const pts = [];
          for (const p of it.paths) pts.push(...along(p, Math.max(res, 1)));
          f = frac(pts, treeAt);
          if (f === f) { it.conf = f >= 0.5 ? 'bonne' : f >= 0.25 ? 'moyenne' : 'faible'; it.confWhy = it.conf === 'bonne' ? null : 'haie peu visible sur l\'orthophoto'; }
        } else if (it.kind === 'massif') {
          const pts = [];
          let k = 0;
          fillPoly(g, it.rings, (i) => { if (k++ % 4 === 0) { const c = i % w, r = (i - c) / w; pts.push([g.xmin + (c + 0.5) * res, g.ymax - (r + 0.5) * res]); } });
          f = frac(pts, treeAt);
          if (f === f) { it.conf = f >= 0.6 ? 'bonne' : f >= 0.35 ? 'moyenne' : 'faible'; it.confWhy = it.conf === 'bonne' ? null : 'boisement partiel sur l\'orthophoto (coupe ?)'; }
        } else if (it.kind === 'mur') {
          f = frac(along(it.coords, Math.max(res, 0.5)), vegAt);
          if (f === f) {
            it.conf = f >= 0.6 ? 'faible' : 'moyenne';
            it.confWhy = it.conf === 'faible' ? 'végétation sur l\'orthophoto : haie taillée plutôt qu\'un mur ?' : 'détection LiDAR seule, à confirmer';
          }
        }
        if (f === f) nChecked++;
      }
      // Cotes d'un bâtiment démoli : à vérifier.
      for (const b of bdCheck) {
        if (!(b.med < 1 && b.seen < 0.4)) continue;
        for (const it of input.plan.items) {
          if (it.kind === 'batiment' && T.pointInRing(it.x, it.y, b.outer)) { it.conf = 'faible'; it.confWhy = 'bâtiment absent du LiDAR et de l\'orthophoto (démoli ?)'; nChecked++; }
        }
      }
    }

    // Changements probables entre le vol LiDAR et l'orthophoto
    const changes = [];
    if (opts.chang !== false && hasMnh) {
      progress(0.85, 'changements entre LiDAR et orthophoto');
      await tick();
      // a) Bâtiment BD TOPO sans hauteur dans le LiDAR
      for (const b of bdCheck) {
        if (b.med >= 1) continue;
        let text;
        if (b.seen >= 0.4) text = order === 'lidar' ? 'Bâtiment sur l\'orthophoto, absent du LiDAR plus récent : démoli ?' : 'Bâtiment sur l\'orthophoto, absent du LiDAR : construit après le vol ?';
        else if (b.seen === b.seen) text = 'Bâtiment BD TOPO absent du LiDAR et de l\'orthophoto : démoli ?';
        else text = 'Bâtiment BD TOPO sans hauteur LiDAR : démoli ou construit après le vol ?';
        changes.push({ kind: 'changement', type: 'bati_sans_lidar', ring: b.outer, x: b.lp[0], y: b.lp[1], text, area: b.area });
      }
      if (cos) {
        // b) Bâti CoSIA hors BD TOPO et cadastre
        const bm = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (zone[i] && src[i] === 1 && C[i] === K.BATI) bm[i] = 20;
        let cc = components(bm, w, h);
        for (const cp of cc.comps) {
          if (cp.n * A < 20) continue;
          let inB = 0;
          const hs = [];
          eachCell(cc.lab, w, cp, (i) => { if (bld[i]) inB++; if (mnh[i] === mnh[i]) hs.push(mnh[i]); });
          if (inB / cp.n > 0.25) continue;
          const ol = outline(g, cc.lab, cp, { organic: false });
          if (!ol) continue;
          const md = median(hs);
          const text = md > 2 ? 'Bâti visible (orthophoto et LiDAR) absent de la BD TOPO et du cadastre'
            : order === 'lidar' ? 'Bâti sur l\'orthophoto, absent du LiDAR plus récent : démoli ?' : 'Bâti sur l\'orthophoto, absent du LiDAR : construction récente ?';
          changes.push({ kind: 'changement', type: 'bati_non_repertorie', ring: ol.rings[0], x: ol.lx, y: ol.ly, text, area: ol.area });
        }
        // c) Volume LiDAR non végétal sans bâti sur l'orthophoto ni dans la BD TOPO
        const vm = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          if (!zone[i] || !(mnh[i] > 2.5) || bld[i] || hyd[i] || road[i] || park[i] || src[i] !== 1) continue;
          const c = C[i];
          if (c === K.BATI || c === K.SERRE || c === K.ARBRE || c === K.ARBUSTE || c === K.HERBE || c === K.CULTURE) continue;
          if (ndvi && ndvi[i] > 0.15) continue;
          vm[i] = 20;
        }
        cc = components(vm, w, h);
        for (const cp of cc.comps) {
          if (cp.n * A < 25) continue;
          const hs = [];
          eachCell(cc.lab, w, cp, (i) => hs.push(mnh[i]));
          if (median(hs) < 3) continue;
          const ol = outline(g, cc.lab, cp, { organic: false });
          if (!ol) continue;
          const text = order === 'lidar' ? 'Volume LiDAR sans bâti sur l\'orthophoto plus ancienne : construit depuis ?' : 'Volume LiDAR absent de l\'orthophoto et de la BD TOPO : démoli depuis le vol ?';
          changes.push({ kind: 'changement', type: 'volume_lidar', ring: ol.rings[0], x: ol.lx, y: ol.ly, text, area: ol.area });
        }
      }
      changes.sort((a, b) => b.area - a.area);
      if (changes.length > 150) changes.length = 150;
    }

    progress(1, 'surfaces prêtes');
    return {
      items: items.concat(changes),
      info: {
        res, zoneArea: nIn * A, batiArea: nBati * A,
        cosia: nZone ? nCos / nZone : 0, cosiaLayer: input.cosiaLayer || null,
        ndvi: !!ndvi, rgb: !!rgb, lidar: hasMnh, checked: nChecked,
        osm: (input.parkings || []).some((f) => f.source === 'osm'),
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Bilan, textes                                                       */
  /* ------------------------------------------------------------------ */

  const fmtArea = (a) => (a < 10 ? a.toFixed(1).replace('.', ',') : String(Math.round(a)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
  const fr2 = (v) => v.toFixed(2).replace('.', ',');

  /** Bilan des surfaces de la zone d'étude (objets non retirés). */
  function bilan(plan) {
    const S = plan && plan.surf;
    if (!S) return null;
    const sums = {};
    for (const it of plan.items) if (it.kind === 'surface' && !it.deleted) sums[it.cls] = (sums[it.cls] || 0) + it.areaZone;
    const rows = [];
    if (S.batiArea > 0) rows.push({ label: 'Bâti (emprise au sol)', area: S.batiArea, cr: 0.95, imper: true, color: '#5b4636' });
    for (const cls of ORDER) if (sums[cls] > 0) rows.push({ label: INFO[cls].label, cls, area: sums[cls], cr: INFO[cls].cr, imper: !!INFO[cls].imper, color: INFO[cls].color });
    const total = S.zoneArea;
    const classed = rows.reduce((a, r) => a + r.area, 0);
    if (total - classed > Math.max(1, total * 0.002)) rows.push({ label: 'Non classé ou retiré', area: total - classed, cr: null, color: '#cccccc' });
    const imper = rows.filter((r) => r.imper).reduce((a, r) => a + r.area, 0);
    const known = rows.filter((r) => r.cr !== null);
    const ka = known.reduce((a, r) => a + r.area, 0);
    const cr = ka ? known.reduce((a, r) => a + r.area * r.cr, 0) / ka : NaN;
    for (const r of rows) r.pct = total ? (100 * r.area) / total : 0;
    return { rows, total, imper, imperPct: total ? (100 * imper) / total : 0, cr };
  }

  /** surfaces.csv : point-virgule et virgule décimale (Excel français). */
  function bilanCSV(b) {
    const out = ['classe;surface_m2;part_pct;coef_ruissellement_indicatif'];
    for (const r of b.rows) out.push(r.label + ';' + r.area.toFixed(1).replace('.', ',') + ';' + r.pct.toFixed(1).replace('.', ',') + ';' + (r.cr === null ? '' : fr2(r.cr)));
    out.push('Total zone d\'étude;' + b.total.toFixed(1).replace('.', ',') + ';100,0;');
    out.push('Surface imperméabilisée;' + b.imper.toFixed(1).replace('.', ',') + ';' + b.imperPct.toFixed(1).replace('.', ',') + ';');
    if (b.cr === b.cr) out.push('Coefficient de ruissellement moyen (indicatif);;;' + fr2(b.cr));
    return '﻿' + out.join('\r\n') + '\r\n';
  }

  const CONF_TXT = { bonne: 'confiance bonne', moyenne: 'confiance moyenne', faible: 'confiance faible' };

  function describe(it) {
    if (it.kind === 'surface') return INFO[it.cls].label + ', ' + fmtArea(it.area) + ' m²' + (it.psrc ? ' (' + it.psrc + ')' : '');
    if (it.kind === 'changement') return 'changement probable : ' + it.text;
    return null;
  }

  /** Entrées de légende des surfaces et des contrôles : [libellé, type, calque]. */
  function legend(plan, on) {
    const out = [], seen = new Set();
    for (const cls of ORDER) {
      const inf = INFO[cls];
      if (seen.has(inf.layer) || !on(inf.key)) continue;
      if (plan.items.some((it) => !it.deleted && it.kind === 'surface' && INFO[it.cls].layer === inf.layer)) { out.push([inf.legend, 'surf', inf.layer]); seen.add(inf.layer); }
    }
    if (on('confiance') && TP.countConf(plan, 'faible', on)) out.push(['À vérifier (indice de confiance faible)', 'ctrl', 'CTRL_A_VERIFIER']);
    if (on('confiance') && TP.countConf(plan, 'moyenne', on)) out.push(['Confiance moyenne', 'ctrl', 'CTRL_CONFIANCE_MOYENNE']);
    if (on('changements') && TP.count(plan, 'changements')) out.push(['Changement probable entre LiDAR et orthophoto', 'chg', 'CTRL_CHANGEMENTS']);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Écriture : DXF, GeoJSON (via TopoPlan)                              */
  /* ------------------------------------------------------------------ */

  const r3 = (v) => Math.round(v * 1000) / 1000;
  const closeRing = (r) => r.concat([r[0]]).map((q) => [r3(q[0]), r3(q[1])]);
  function inRings(x, y, rings) {
    let inside = false;
    for (const r of rings) if (T.pointInRing(x, y, r)) inside = !inside;
    return inside;
  }
  const layerList = [];
  for (const cls of ORDER) if (!layerList.some((l) => l[0] === INFO[cls].layer)) layerList.push([INFO[cls].layer, INFO[cls].aci]);
  layerList.push(['SURF_TEXTE', 7]);

  TP.register('surface', {
    key: (it) => INFO[it.cls].key,
    layers: layerList,
    dist(it, x, y, tol) {
      let d = Infinity;
      for (const r of it.rings) d = Math.min(d, TP.distToPoly(x, y, r, true));
      if (d <= tol * 0.5) return d;
      return inRings(x, y, it.rings) ? tol * 0.95 : d;
    },
    dxf(dxf, it, c) {
      const inf = INFO[it.cls];
      for (const r of it.rings) dxf.poly2d(r, true, inf.layer, 0);
      if (c.on('surfTxt') && it.rad >= c.ts * 1.6) {
        const h = c.ts;
        dxf.text(it.lx, it.ly + h * 0.35, 0, h, inf.label, 'SURF_TEXTE', 0, 'center', 0.85);
        dxf.text(it.lx, it.ly - h * 1.25, 0, h, fmtArea(it.area) + ' m²', 'SURF_TEXTE', 0, 'center', 0.85);
      }
    },
    feature(it) {
      return ['surfaces', {
        type: 'Feature',
        properties: { classe: INFO[it.cls].label, code: it.cls, surface_m2: Math.round(it.area * 10) / 10, source: it.src + (it.psrc ? ', ' + it.psrc : '') },
        geometry: { type: 'Polygon', coordinates: it.rings.map(closeRing) },
      }];
    },
  });

  TP.register('changement', {
    key: () => 'changements',
    layers: [['CTRL_CHANGEMENTS', 6, 'TIRETS']],
    dist(it, x, y, tol) {
      if (it.ring) { const d = TP.distToPoly(x, y, it.ring, true); return d <= tol * 0.5 ? d : T.pointInRing(x, y, it.ring) ? tol * 0.5 : d; }
      return Math.hypot(it.x - x, it.y - y);
    },
    dxf(dxf, it, c) {
      const Lc = 'CTRL_CHANGEMENTS', s = c.th * 1.3;
      if (it.ring) dxf.poly2d(it.ring, true, Lc, 0);
      dxf.poly2d([[it.x, it.y + s], [it.x - s * 0.95, it.y - s * 0.65], [it.x + s * 0.95, it.y - s * 0.65]], true, Lc, 0);
      dxf.text(it.x, it.y - s * 0.5, 0, s * 0.9, '!', Lc, 0, 'center', 0.85);
      dxf.text(it.x, it.y - s * 1.9, 0, c.ts * 0.8, it.text, Lc, 0, 'center', 0.85);
    },
    feature(it) {
      return ['changements_probables', {
        type: 'Feature',
        properties: { type: it.type, description: it.text, surface_m2: Math.round(it.area) },
        geometry: it.ring ? { type: 'Polygon', coordinates: [closeRing(it.ring)] } : { type: 'Point', coordinates: [r3(it.x), r3(it.y)] },
      }];
    },
  });

  return { K, O, COSIA, INFO, ORDER, CONF_TXT, decodeCosia, analyse, bilan, bilanCSV, legend, describe, fmtArea, inRings,
    _internal: { fillPoly, bufferLine, components, outline, roadWidth, lut } };
});
