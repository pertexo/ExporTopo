/*!
 * ExporTopo — Plan TN détaillé : détection automatique, à partir du MNT et du MNS LiDAR HD,
 * des talus, fossés et noues, lignes de crête, points hauts et bas, arbres, haies, massifs boisés,
 * murs, et cotes des bâtiments ; écriture des calques DXF correspondants et de la mise en page.
 * Aucune dépendance autre que core.js ; testable sous Node.
 * Licence MIT.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.TopoPlan = factory(root.TopoCore);
})(typeof self !== 'undefined' ? self : this, function (T) {
  'use strict';

  /** Seuils de détection selon la sensibilité choisie. */
  const SENSI = {
    faible: { slope: 0.50, drop: 0.60, area: 12, tpi: 0.20, len: 10 },
    moyenne: { slope: 0.35, drop: 0.40, area: 8, tpi: 0.12, len: 6 },
    forte: { slope: 0.25, drop: 0.30, area: 5, tpi: 0.08, len: 4 },
  };

  const valid = (z) => z === z && z > -1000 && z < 9000;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /* ------------------------------------------------------------------ */
  /* Outils raster                                                       */
  /* ------------------------------------------------------------------ */

  function zoneMask(g, ring, margin) {
    const m = new Uint8Array(g.w * g.h);
    const bb = T.ringBBox(ring, margin);
    for (let r = 0; r < g.h; r++) {
      const y = g.ymax - (r + 0.5) * g.res;
      if (y < bb[1] || y > bb[3]) continue;
      for (let c = 0; c < g.w; c++) {
        const x = g.xmin + (c + 0.5) * g.res;
        if (x < bb[0] || x > bb[2]) continue;
        if (T.inZone(x, y, ring, margin)) m[r * g.w + c] = 1;
      }
    }
    return m;
  }

  /** Rasterise des anneaux (contours extérieurs de polygones). */
  function polyMask(g, rings) {
    const m = new Uint8Array(g.w * g.h);
    for (const ring of rings) {
      const bb = T.ringBBox(ring, 0);
      const c0 = Math.max(0, Math.floor((bb[0] - g.xmin) / g.res)), c1 = Math.min(g.w - 1, Math.ceil((bb[2] - g.xmin) / g.res));
      const r0 = Math.max(0, Math.floor((g.ymax - bb[3]) / g.res)), r1 = Math.min(g.h - 1, Math.ceil((g.ymax - bb[1]) / g.res));
      for (let r = r0; r <= r1; r++) {
        const y = g.ymax - (r + 0.5) * g.res;
        for (let c = c0; c <= c1; c++) {
          if (T.pointInRing(g.xmin + (c + 0.5) * g.res, y, ring)) m[r * g.w + c] = 1;
        }
      }
    }
    return m;
  }

  /** Dilatation carrée de rayon r (en mailles), séparable. */
  function dilate(m, w, h, r) {
    if (r <= 0) return m.slice();
    const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const b = y * w;
      let cnt = 0;
      for (let x = -r; x < w; x++) {
        const add = x + r; if (add < w) cnt += m[b + add];
        const rem = x - r - 1; if (rem >= 0) cnt -= m[b + rem];
        if (x >= 0) t[b + x] = cnt > 0 ? 1 : 0;
      }
    }
    for (let x = 0; x < w; x++) {
      let cnt = 0;
      for (let y = -r; y < h; y++) {
        const add = y + r; if (add < h) cnt += t[add * w + x];
        const rem = y - r - 1; if (rem >= 0) cnt -= t[rem * w + x];
        if (y >= 0) o[y * w + x] = cnt > 0 ? 1 : 0;
      }
    }
    return o;
  }

  function erode(m, w, h, r) {
    const inv = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1;
    const d = dilate(inv, w, h, r);
    for (let i = 0; i < d.length; i++) d[i] = d[i] ? 0 : 1;
    return d;
  }

  /** Composantes connexes (8-connexité). */
  function components(m, w, h) {
    const lab = new Int32Array(w * h).fill(-1);
    const cells = [];
    const stack = new Int32Array(w * h);
    for (let i = 0; i < m.length; i++) {
      if (!m[i] || lab[i] >= 0) continue;
      const id = cells.length, list = [];
      let sp = 0; stack[sp++] = i; lab[i] = id;
      while (sp) {
        const p = stack[--sp]; list.push(p);
        const x = p % w, y = (p - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (m[q] && lab[q] < 0) { lab[q] = id; stack[sp++] = q; }
          }
        }
      }
      cells.push(list);
    }
    return { lab, cells };
  }

  /** Moyenne glissante sur une fenêtre carrée de rayon rad, en ignorant les trous. */
  function boxMean(data, w, h, rad) {
    const W = w + 1;
    const S = new Float64Array(W * (h + 1)), N = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let rs = 0, rn = 0;
      for (let x = 0; x < w; x++) {
        const v = data[y * w + x];
        if (valid(v)) { rs += v; rn++; }
        S[(y + 1) * W + x + 1] = S[y * W + x + 1] + rs;
        N[(y + 1) * W + x + 1] = N[y * W + x + 1] + rn;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1);
        const s = S[y1 * W + x1] - S[y0 * W + x1] - S[y1 * W + x0] + S[y0 * W + x0];
        const n = N[y1 * W + x1] - N[y0 * W + x1] - N[y1 * W + x0] + N[y0 * W + x0];
        out[y * w + x] = n ? s / n : NaN;
      }
    }
    return out;
  }

  /** Filtre max (sign=1) ou min (sign=-1) sur fenêtre carrée, séparable. */
  function extremeFilter(data, w, h, rad, sign) {
    const t = new Float32Array(w * h), o = new Float32Array(w * h);
    const worst = -Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = worst;
        for (let k = Math.max(0, x - rad); k <= Math.min(w - 1, x + rad); k++) {
          const v = data[y * w + k]; if (valid(v) && sign * v > best) best = sign * v;
        }
        t[y * w + x] = best;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let best = worst;
        for (let k = Math.max(0, y - rad); k <= Math.min(h - 1, y + rad); k++) {
          const v = t[k * w + x]; if (v > best) best = v;
        }
        o[y * w + x] = sign * best;
      }
    }
    return o;
  }

  /** Squelettisation de Zhang-Suen. */
  function thin(m, w, h) {
    const a = m.slice();
    const del = [];
    let changed = true, guard = 0;
    while (changed && guard++ < 500) {
      changed = false;
      for (let pass = 0; pass < 2; pass++) {
        del.length = 0;
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (!a[i]) continue;
            const p2 = a[i - w], p3 = a[i - w + 1], p4 = a[i + 1], p5 = a[i + w + 1], p6 = a[i + w], p7 = a[i + w - 1], p8 = a[i - 1], p9 = a[i - w - 1];
            const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (B < 2 || B > 6) continue;
            const A = (!p2 && p3 ? 1 : 0) + (!p3 && p4 ? 1 : 0) + (!p4 && p5 ? 1 : 0) + (!p5 && p6 ? 1 : 0) +
              (!p6 && p7 ? 1 : 0) + (!p7 && p8 ? 1 : 0) + (!p8 && p9 ? 1 : 0) + (!p9 && p2 ? 1 : 0);
            if (A !== 1) continue;
            if (pass === 0) { if (p2 && p4 && p6) continue; if (p4 && p6 && p8) continue; }
            else { if (p2 && p4 && p8) continue; if (p2 && p6 && p8) continue; }
            del.push(i);
          }
        }
        if (del.length) { changed = true; for (const i of del) a[i] = 0; }
      }
    }
    return a;
  }

  /** Voisins d'un pixel de squelette (diagonales seulement sans raccourci orthogonal). */
  function skelNeighbors(a, w, h, i) {
    const x = i % w, y = (i - x) / w, out = [];
    const on = (xx, yy) => xx >= 0 && yy >= 0 && xx < w && yy < h && a[yy * w + xx];
    const N = on(x, y - 1), S = on(x, y + 1), E = on(x + 1, y), W = on(x - 1, y);
    if (N) out.push(i - w); if (S) out.push(i + w); if (E) out.push(i + 1); if (W) out.push(i - 1);
    if (on(x + 1, y - 1) && !N && !E) out.push(i - w + 1);
    if (on(x - 1, y - 1) && !N && !W) out.push(i - w - 1);
    if (on(x + 1, y + 1) && !S && !E) out.push(i + w + 1);
    if (on(x - 1, y + 1) && !S && !W) out.push(i + w - 1);
    return out;
  }

  /** Suit le squelette et renvoie des chemins (listes d'indices) entre extrémités et carrefours. */
  function traceSkeleton(a, w, h) {
    const nb = new Map();
    for (let i = 0; i < a.length; i++) if (a[i]) nb.set(i, skelNeighbors(a, w, h, i));
    const seen = new Set();
    const key = (p, q) => (p < q ? p * 1e7 + q : q * 1e7 + p);
    const paths = [];
    const walk = (p, q) => {
      const path = [p, q]; seen.add(key(p, q));
      let prev = p, cur = q;
      while (nb.get(cur).length === 2) {
        const nx = nb.get(cur).find((n) => n !== prev && !seen.has(key(cur, n)));
        if (nx === undefined) break;
        seen.add(key(cur, nx)); path.push(nx); prev = cur; cur = nx;
      }
      return path;
    };
    for (const [p, ns] of nb) {
      if (ns.length === 2) continue;
      if (ns.length === 0) { paths.push([p]); continue; }
      for (const q of ns) if (!seen.has(key(p, q))) paths.push(walk(p, q));
    }
    for (const [p, ns] of nb) { // boucles fermées
      for (const q of ns) if (!seen.has(key(p, q))) paths.push(walk(p, q));
    }
    return paths;
  }

  /** Squelette d'un ensemble de mailles → polylignes (coordonnées monde) et longueur totale. */
  function skeletonOf(cells, g) {
    let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
    for (const i of cells) { const c = i % g.w, r = (i - c) / g.w; if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r; }
    c0 -= 1; r0 -= 1;
    const w = c1 - c0 + 2, h = r1 - r0 + 2;
    const m = new Uint8Array(w * h);
    for (const i of cells) { const c = i % g.w, r = (i - c) / g.w; m[(r - r0) * w + (c - c0)] = 1; }
    const sk = thin(m, w, h);
    const paths = traceSkeleton(sk, w, h).map((p) => p.map((j) => {
      const c = j % w, r = (j - c) / w;
      return [g.xmin + (c + c0 + 0.5) * g.res, g.ymax - (r + r0 + 0.5) * g.res];
    }));
    let total = 0;
    for (const p of paths) total += polyLength(p);
    return { paths, length: total };
  }

  /** Grille de travail à partir d'un tableau de valeurs. */
  function gridOf(g, data) { return { xmin: g.xmin, ymax: g.ymax, res: g.res, w: g.w, h: g.h, data }; }

  function cellAt(g, x, y) {
    const c = Math.floor((x - g.xmin) / g.res), r = Math.floor((g.ymax - y) / g.res);
    if (c < 0 || r < 0 || c >= g.w || r >= g.h) return -1;
    return r * g.w + c;
  }

  const cellXY = (g, i) => { const c = i % g.w, r = (i - c) / g.w; return [g.xmin + (c + 0.5) * g.res, g.ymax - (r + 0.5) * g.res]; };

  /* ------------------------------------------------------------------ */
  /* Géométrie des polylignes                                            */
  /* ------------------------------------------------------------------ */

  function polyLength(p) {
    let L = 0;
    for (let k = 1; k < p.length; k++) L += Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
    return L;
  }

  function chaikin(p, it, closed) {
    let q = p;
    for (let n = 0; n < it; n++) {
      if (q.length < 3) return q;
      const o = closed ? [] : [q[0]];
      const m = closed ? q.length : q.length - 1;
      for (let k = 0; k < m; k++) {
        const a = q[k], b = q[(k + 1) % q.length];
        o.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
      }
      if (!closed) o.push(q[q.length - 1]);
      q = o;
    }
    return q;
  }

  /** Point et direction à l'abscisse curviligne s. */
  function pointAt(p, s) {
    let acc = 0;
    for (let k = 1; k < p.length; k++) {
      const a = p[k - 1], b = p[k], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc + L >= s || k === p.length - 1) {
        const t = L ? Math.min(1, Math.max(0, (s - acc) / L)) : 0;
        return { x: a[0] + t * (b[0] - a[0]), y: a[1] + t * (b[1] - a[1]), dx: L ? (b[0] - a[0]) / L : 1, dy: L ? (b[1] - a[1]) / L : 0 };
      }
      acc += L;
    }
    return { x: p[0][0], y: p[0][1], dx: 1, dy: 0 };
  }

  function readableAngle(dx, dy) {
    let a = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (a > 90) a -= 180; if (a < -90) a += 180;
    return a;
  }

  function median(arr) {
    if (!arr.length) return NaN;
    const s = Float64Array.from(arr).sort();
    return s[Math.floor(s.length / 2)];
  }

  function quantile(arr, q) {
    if (!arr.length) return NaN;
    const s = Float64Array.from(arr).sort();
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  }

  /** Distance d'un point à une polyligne. */
  function distToPoly(x, y, p, closed) {
    let best = Infinity;
    const n = closed ? p.length : p.length - 1;
    for (let k = 0; k < n; k++) {
      const a = p[k], b = p[(k + 1) % p.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      let t = l2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
      if (d < best) best = d;
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Analyse                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Analyse la zone et renvoie { items, res }.
   * input = { mnt, mns (ou null), ring, margin, buildings: [features BD TOPO], cadBati: [features],
   *           constructions: [features], haiesIgn: [features], opts: { sensi, hmin, talus, fosses, cretes,
   *           extremes, arbres, haies, massifs, murs, constructions, batCotes } }
   */
  async function analyse(input, progress) {
    progress = progress || (() => {});
    const o = input.opts;
    const S = SENSI[o.sensi] || SENSI.moyenne;
    const hmin = o.hmin || 3;
    let mnt = input.mnt, mns = input.mns;
    // Grille de travail limitée à ~3 millions de mailles.
    const n0 = mnt.w * mnt.h;
    if (n0 > 3e6) {
      const f = Math.ceil(Math.sqrt(n0 / 3e6));
      mnt = T.downsample(mnt, f);
      if (mns) mns = T.downsample(mns, f);
    }
    const g = mnt, w = g.w, h = g.h, res = g.res, N = w * h;
    const ring = input.ring, margin = input.margin || 0;
    const items = [];
    let uid = 1;
    const add = (it) => { it.id = uid++; items.push(it); return it; };

    progress(0.02, 'Préparation du relief');
    await tick();
    const zs = T.smoothGrid(g, res <= 0.5 ? 2 : 1).data;
    const zsG = gridOf(g, zs);
    const zone = zoneMask(g, ring, margin);
    const zoneWide = zoneMask(g, ring, margin + 3);
    const bRings = [];
    for (const f of (input.buildings || []).concat(input.cadBati || [])) {
      T.eachPart(f.geometry, (coords, closed) => { if (closed && coords.length > 3) bRings.push(T.stripClosing(coords)); });
    }
    const bmask = polyMask(g, bRings);
    const bmask1 = dilate(bmask, w, h, Math.max(1, Math.round(0.5 / res)));
    const bmask2 = dilate(bmask, w, h, Math.max(1, Math.round(1.0 / res)));

    // Pente
    const slope = new Float32Array(N).fill(NaN);
    for (let r = 1; r < h - 1; r++) {
      for (let c = 1; c < w - 1; c++) {
        const i = r * w + c;
        const gx = (zs[i + 1] - zs[i - 1]) / (2 * res), gy = (zs[i - w] - zs[i + w]) / (2 * res);
        if (valid(zs[i + 1]) && valid(zs[i - 1]) && valid(zs[i - w]) && valid(zs[i + w])) slope[i] = Math.hypot(gx, gy);
      }
    }

    /* ---------------- Talus ---------------- */
    let talusKeep = new Uint8Array(N);
    if (o.talus || o.cretes) {
      progress(0.08, 'Talus');
      await tick();
      const zone2 = zoneMask(g, ring, margin + 2);
      let steep = new Uint8Array(N);
      for (let i = 0; i < N; i++) steep[i] = zone2[i] && !bmask1[i] && slope[i] >= S.slope ? 1 : 0;
      steep = erode(dilate(steep, w, h, 1), w, h, 1);
      for (let i = 0; i < N; i++) if (!zone2[i]) steep[i] = 0;
      const cc = components(steep, w, h);
      const keepId = new Int32Array(N).fill(-1);
      cc.cells.forEach((cells, id) => {
        const area = cells.length * res * res;
        if (area < S.area) return;
        let zmin = Infinity, zmax = -Infinity;
        for (const i of cells) { const z = zs[i]; if (valid(z)) { if (z < zmin) zmin = z; if (z > zmax) zmax = z; } }
        if (zmax - zmin < S.drop) return;
        for (const i of cells) { talusKeep[i] = 1; keepId[i] = id; }
      });
      if (o.talus) {
        const field = new Float32Array(N);
        for (let i = 0; i < N; i++) field[i] = talusKeep[i];
        const fG = T.smoothGrid(gridOf(g, field), 1);
        const outlines = T.contours(fG, 1, { levels: [0.5], simplify: 0 });
        const groups = new Map(); // id composante -> item
        const d1 = Math.max(0.6, 1.5 * res), d2 = Math.max(1.0, 2 * res);
        for (const ol of outlines) {
          const P = ol.closed ? ol.coords.slice(0, -1) : ol.coords;
          const n = P.length;
          if (n < 3) continue;
          const cls = new Int8Array(n), cid = new Int32Array(n).fill(-1);
          for (let k = 0; k < n; k++) {
            const a = P[(k - 1 + n) % n], b = P[(k + 1) % n], p = P[k];
            let tx = b[0] - a[0], ty = b[1] - a[1];
            const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
            let nx = -ty, ny = tx;
            const fa = T.sample(fG, p[0] + nx * d1, p[1] + ny * d1), fb = T.sample(fG, p[0] - nx * d1, p[1] - ny * d1);
            if ((fa || 0) > (fb || 0)) { nx = -nx; ny = -ny; } // n pointe vers l'extérieur du talus
            if (!T.inZone(p[0], p[1], ring, margin + 0.5)) continue;
            const zo = T.sample(zsG, p[0] + nx * d2, p[1] + ny * d2), zi = T.sample(zsG, p[0] - nx * d2, p[1] - ny * d2);
            if (!valid(zo) || !valid(zi)) continue;
            const dz = zo - zi;
            cls[k] = dz > 0.05 ? 1 : dz < -0.05 ? -1 : 0;
            for (const dd of [d1 * 0.7, d1 * 1.4, d2 * 1.5]) {
              const ci = cellAt(g, p[0] - nx * dd, p[1] - ny * dd);
              if (ci >= 0 && keepId[ci] >= 0) { cid[k] = keepId[ci]; break; }
            }
          }
          // lissage majoritaire des classes
          const sm = new Int8Array(n);
          for (let k = 0; k < n; k++) {
            const a = cls[(k - 1 + n) % n], b = cls[k], c = cls[(k + 1) % n];
            sm[k] = (a === c && ol.closed) || (a === c && k > 0 && k < n - 1) ? a : b;
          }
          // découpage en tronçons homogènes
          let start = 0;
          if (ol.closed) { for (let k = 0; k < n; k++) if (sm[k] !== sm[(k - 1 + n) % n] || cid[k] !== cid[(k - 1 + n) % n]) { start = k; break; } }
          let run = [], rc = sm[start], rid = cid[start];
          const flush = () => {
            if (rc !== 0 && rid >= 0 && run.length >= 3) {
              let coords = chaikin(run, 2, false);
              coords = T.simplify(coords, 0.05);
              if (polyLength(coords) >= 1.5) {
                let it = groups.get(rid);
                if (!it) { it = add({ kind: 'talus', lines: [], barbules: [], label: null }); groups.set(rid, it); }
                it.lines.push({ type: rc > 0 ? 'crete' : 'pied', coords: coords.map((q) => [q[0], q[1], T.sample(g, q[0], q[1])]) });
              }
            }
            run = [];
          };
          for (let s = 0; s < n; s++) {
            const k = (start + s) % n;
            if (sm[k] !== rc || cid[k] !== rid) { flush(); rc = sm[k]; rid = cid[k]; }
            run.push(P[k]);
          }
          flush();
        }
        // Barbules et hauteur de talus
        const sp = Math.max(0.4, 3 * (o.scale || 200) / 1000);
        const stepM = res / 2;
        const inSteep = (x, y) => { const ci = cellAt(g, x, y); return ci >= 0 && talusKeep[ci]; };
        for (const it of groups.values()) {
          const drops = [];
          const pieds = it.lines.filter((l) => l.type === 'pied').map((l) => l.coords);
          let count = 0;
          for (const ln of it.lines) {
            if (ln.type !== 'crete') continue;
            const L = polyLength(ln.coords);
            for (let s = sp / 2; s < L; s += sp) {
              const q = pointAt(ln.coords, s);
              let nx = -q.dy, ny = q.dx;
              const za = T.sample(zsG, q.x + nx, q.y + ny), zb = T.sample(zsG, q.x - nx, q.y - ny);
              if (valid(za) && valid(zb) && za > zb) { nx = -nx; ny = -ny; } // vers le bas
              // Longueur : jusqu'à la ligne de pied du même talus si le rayon la rencontre, sinon fin de la zone pentue.
              let len = Infinity;
              for (const pl of pieds) {
                for (let j = 0; j + 1 < pl.length; j++) {
                  const a = pl[j], b = pl[j + 1], ex2 = b[0] - a[0], ey2 = b[1] - a[1];
                  const den = nx * ey2 - ny * ex2;
                  if (Math.abs(den) < 1e-9) continue;
                  const t = ((a[0] - q.x) * ey2 - (a[1] - q.y) * ex2) / den;
                  const u = ((a[0] - q.x) * ny - (a[1] - q.y) * nx) / den;
                  if (t > 0.2 && t < 40 && u >= 0 && u <= 1 && t < len) len = t;
                }
              }
              if (len === Infinity) {
                let k = 1, last = 0;
                const maxK = Math.ceil(40 / stepM);
                for (; k < maxK; k++) {
                  const x = q.x + nx * k * stepM, y = q.y + ny * k * stepM;
                  if (inSteep(x, y)) last = k;
                  else if (k * stepM > (last ? 0.6 : 2) && k - last > 2) break;
                }
                len = last * stepM + stepM;
              }
              if (len < 0.4) continue;
              const full = count % 2 === 0;
              const l2 = full ? len * 0.95 : len * 0.5;
              const ex = q.x + nx * l2, ey = q.y + ny * l2;
              const z0 = T.sample(g, q.x, q.y), z1 = T.sample(g, ex, ey);
              it.barbules.push([[q.x, q.y, valid(z0) ? z0 : 0], [ex, ey, valid(z1) ? z1 : 0]]);
              // dénivelé mesuré un peu au-delà de la crête et du pied, sur les parties planes
              const zt = T.sample(g, q.x - nx * 0.75, q.y - ny * 0.75), zb2 = T.sample(g, q.x + nx * (len + 0.75), q.y + ny * (len + 0.75));
              if (valid(zt) && valid(zb2)) drops.push(zt - zb2);
              count++;
            }
          }
          const crete = it.lines.filter((l) => l.type === 'crete').sort((a, b) => polyLength(b.coords) - polyLength(a.coords))[0];
          const ref = crete || it.lines[0];
          if (ref) {
            const q = pointAt(ref.coords, polyLength(ref.coords) / 2);
            const hgt = drops.length ? median(drops) : NaN;
            it.h = hgt;
            it.label = { x: q.x, y: q.y, rot: readableAngle(q.dx, q.dy), nx: -q.dy, ny: q.dx, text: valid(hgt) && hgt > 0 ? 'Talus h ' + hgt.toFixed(2) : 'Talus' };
          }
        }
        for (const it of groups.values()) if (!it.lines.length) it.deleted = true;
      }
    }

    /* ---------------- Fossés, noues et lignes de crête ---------------- */
    let tpi = null;
    if (o.fosses || o.cretes) {
      progress(0.25, 'Fossés et noues');
      await tick();
      const rad = Math.max(2, Math.round(3 / res));
      const mean = boxMean(zs, w, h, rad);
      tpi = new Float32Array(N);
      for (let i = 0; i < N; i++) tpi[i] = valid(zs[i]) && valid(mean[i]) ? zs[i] - mean[i] : NaN;
      const lines = (sign, excl) => {
        const m = new Uint8Array(N);
        for (let i = 0; i < N; i++) m[i] = zone[i] && !bmask1[i] && !(excl && excl[i]) && sign * tpi[i] >= S.tpi ? 1 : 0;
        const cc = components(m, w, h);
        const out = [];
        for (const cells of cc.cells) {
          const area = cells.length * res * res;
          if (area < S.len * 0.5) continue;
          let peak = 0;
          for (const i of cells) if (sign * tpi[i] > peak) peak = sign * tpi[i];
          if (peak < S.tpi * 1.5) continue;
          const sk = skeletonOf(cells, g);
          if (sk.length < S.len || area / sk.length > 8) continue;
          for (const p of sk.paths) {
            if (p.length < 2 || polyLength(p) < Math.max(2, S.len / 3)) continue;
            // Contrôle en travers : un fossé est plus bas que ses DEUX bords (un pied de talus ne l'est que d'un côté).
            const sm = chaikin(p, 2, false), Lp = polyLength(sm), t = S.tpi * 0.7;
            let run = [];
            const flush = () => {
              if (run.length >= 2 && polyLength(run) >= Math.max(3, S.len / 2)) out.push(T.simplify(run, 0.15));
              run = [];
            };
            for (let s = 0; s <= Lp + 1e-6; s += 1) {
              const q = pointAt(sm, Math.min(s, Lp));
              const zc = T.sample(zsG, q.x, q.y);
              let ok = false;
              for (const d of [1.5, 2.5, 4]) {
                const zl = T.sample(zsG, q.x - q.dy * d, q.y + q.dx * d), zr = T.sample(zsG, q.x + q.dy * d, q.y - q.dx * d);
                if (valid(zc) && valid(zl) && valid(zr) && sign * (zc - zl) >= t && sign * (zc - zr) >= t) { ok = true; break; }
              }
              if (ok) run.push([q.x, q.y]); else flush();
            }
            flush();
          }
        }
        return out;
      };
      if (o.fosses) {
        // fil d'eau : point le plus bas autour du tracé
        const fe = (x, y) => {
          const ci = cellAt(g, x, y); if (ci < 0) return NaN;
          let best = Infinity;
          const c = ci % w, r = (ci - c) / w;
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc2 = c + dc; if (rr < 0 || cc2 < 0 || rr >= h || cc2 >= w) continue;
            const z = g.data[rr * w + cc2]; if (valid(z) && z < best) best = z;
          }
          return best === Infinity ? NaN : best;
        };
        for (const p of lines(-1, null)) {
          const coords = p.map((q) => [q[0], q[1], fe(q[0], q[1])]);
          const z0 = coords[0][2], z1 = coords[coords.length - 1][2];
          const flow = valid(z0) && valid(z1) && Math.abs(z0 - z1) >= 0.05 ? (z1 < z0 ? 1 : -1) : 0;
          const L = polyLength(coords);
          const labels = [];
          const marks = L >= 4 ? [0.5, L - 0.5] : [L / 2];
          for (let s = 20; s < L - 10; s += 20) marks.push(s);
          for (const s of marks) {
            const q = pointAt(coords, s);
            const z = fe(q.x, q.y);
            if (valid(z)) labels.push({ x: q.x, y: q.y, z, rot: readableAngle(q.dx, q.dy), nx: -q.dy, ny: q.dx, text: 'FE ' + z.toFixed(2) });
          }
          add({ kind: 'fosse', coords, flow, labels, len: L });
        }
      }
      if (o.cretes) {
        progress(0.32, 'Lignes de crête');
        await tick();
        const excl = dilate(talusKeep, w, h, Math.max(2, Math.round(2 / res)));
        for (const p of lines(1, excl)) {
          add({ kind: 'crete', coords: p.map((q) => [q[0], q[1], T.sample(g, q[0], q[1])]) });
        }
      }
    }

    /* ---------------- Points hauts et bas ---------------- */
    if (o.extremes) {
      progress(0.38, 'Points hauts et bas');
      await tick();
      const rad = Math.max(3, Math.round(5 / res));
      const mx = extremeFilter(zs, w, h, rad, 1), mn = extremeFilter(zs, w, h, rad, -1);
      const mean = boxMean(zs, w, h, rad);
      const inner = erode(zone, w, h, Math.max(1, Math.round(1 / res)));
      const cand = { haut: [], bas: [] };
      let gmax = -1, gmin = -1;
      for (let i = 0; i < N; i++) {
        if (!zone[i] || !valid(zs[i])) continue;
        if (gmax < 0 || zs[i] > zs[gmax]) gmax = i;
        if (gmin < 0 || zs[i] < zs[gmin]) gmin = i;
        if (!inner[i]) continue;
        if (zs[i] === mx[i] && zs[i] - mean[i] >= 0.15) cand.haut.push([i, zs[i] - mean[i]]);
        if (zs[i] === mn[i] && mean[i] - zs[i] >= 0.15) cand.bas.push([i, mean[i] - zs[i]]);
      }
      for (const type of ['haut', 'bas']) {
        const kept = [];
        const glob = type === 'haut' ? gmax : gmin;
        const list = cand[type].sort((a, b) => b[1] - a[1]);
        if (glob >= 0) list.unshift([glob, Infinity]);
        for (const [i] of list) {
          const p = cellXY(g, i);
          if (kept.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 5)) continue;
          kept.push(p);
          const z = g.data[i];
          if (valid(z)) add({ kind: 'extreme', type, x: p[0], y: p[1], z });
          if (kept.length >= 20) break;
        }
      }
    }

    /* ---------------- Sursol : arbres, haies, massifs, murs ---------------- */
    const needVeg = mns && (o.arbres || o.haies || o.massifs || o.murs);
    let chm = null, owner = null;
    if (needVeg) {
      progress(0.45, 'Hauteur de la végétation');
      await tick();
      chm = new Float32Array(N).fill(NaN);
      for (let i = 0; i < N; i++) {
        const a = mns.data[i], b = g.data[i];
        if (valid(a) && valid(b)) chm[i] = Math.max(0, a - b);
      }
      const chmS = T.smoothGrid(gridOf(g, chm), 1).data;
      const vzone = (i) => zoneWide[i] && !bmask2[i];

      // Arbres : cimes = maxima locaux, houppiers par croissance de région
      owner = new Int32Array(N).fill(-1);
      const tops = [];
      if (o.arbres) {
        progress(0.5, 'Arbres');
        await tick();
        for (let i = 0; i < N; i++) {
          const v = chmS[i];
          if (!(v >= hmin) || !vzone(i)) continue;
          const rad = Math.max(2, Math.round(Math.min(4, Math.max(1.5, 1 + 0.1 * v)) / res));
          const c = i % w, r = (i - c) / w;
          let top = true;
          for (let dr = -rad; dr <= rad && top; dr++) {
            const rr = r + dr; if (rr < 0 || rr >= h) continue;
            for (let dc = -rad; dc <= rad; dc++) {
              const cc2 = c + dc; if (cc2 < 0 || cc2 >= w || (dr === 0 && dc === 0)) continue;
              if (dr * dr + dc * dc > rad * rad) continue;
              const j = rr * w + cc2, u = chmS[j];
              if (u > v || (u === v && j < i)) { top = false; break; }
            }
          }
          if (top) { owner[i] = tops.length; tops.push({ i, h: v }); }
        }
        // croissance des houppiers, des plus hauts aux plus bas
        const bins = new Map();
        for (let i = 0; i < N; i++) {
          const v = chmS[i];
          if (!(v >= 1.5) || !vzone(i) || owner[i] >= 0) continue;
          const b = Math.floor(v * 10);
          let l = bins.get(b); if (!l) { l = []; bins.set(b, l); } l.push(i);
        }
        const keys = Array.from(bins.keys()).sort((a, b) => b - a);
        const topXY = tops.map((t) => cellXY(g, t.i));
        for (const b of keys) {
          let pending = bins.get(b);
          for (let pass = 0; pass < 3 && pending.length; pass++) {
            const rest = [];
            for (const i of pending) {
              const c = i % w, r = (i - c) / w;
              let best = -1, bv = -Infinity;
              for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                const rr = r + dr, cc2 = c + dc; if (rr < 0 || cc2 < 0 || rr >= h || cc2 >= w) continue;
                const j = rr * w + cc2;
                if (owner[j] >= 0 && chmS[j] > bv) { bv = chmS[j]; best = owner[j]; }
              }
              if (best < 0) { rest.push(i); continue; }
              const t = tops[best], p = cellXY(g, i), q = topXY[best];
              const maxR = Math.min(12, Math.max(2, 0.35 * t.h + 1));
              if (chmS[i] >= 0.35 * t.h && Math.hypot(p[0] - q[0], p[1] - q[1]) <= maxR) owner[i] = best;
            }
            pending = rest;
          }
        }
        const area = new Float64Array(tops.length), bx = tops.map(() => [Infinity, Infinity, -Infinity, -Infinity]);
        for (let i = 0; i < N; i++) {
          const t = owner[i]; if (t < 0) continue;
          area[t] += res * res;
          const c = i % w, r = (i - c) / w, B = bx[t];
          if (c < B[0]) B[0] = c; if (r < B[1]) B[1] = r; if (c > B[2]) B[2] = c; if (r > B[3]) B[3] = r;
        }
        tops.forEach((t, k) => {
          const [x, y] = topXY[k];
          if (!T.inZone(x, y, ring, margin + 1)) return;
          if (area[k] < 2.5) return;
          const B = bx[k], ew = (B[2] - B[0] + 1), eh = (B[3] - B[1] + 1);
          if (Math.max(ew, eh) / Math.min(ew, eh) > 4) return;
          const R = Math.min(Math.sqrt(area[k] / Math.PI), 0.5 * t.h + 2);
          const z = T.sample(g, x, y);
          const hh = valid(chm[t.i]) ? Math.max(chm[t.i], t.h) : t.h;
          add({ kind: 'arbre', x, y, z: valid(z) ? z : 0, h: hh, d: 2 * R });
        });
      }

      // Haies et massifs boisés
      if (o.haies || o.massifs) {
        progress(0.62, 'Haies et massifs boisés');
        await tick();
        let veg = new Uint8Array(N);
        for (let i = 0; i < N; i++) veg[i] = chmS[i] >= 1.0 && vzone(i) ? 1 : 0;
        veg = erode(dilate(veg, w, h, 1), w, h, 1);
        const cc = components(veg, w, h);
        for (const cells of cc.cells) {
          const A = cells.length * res * res;
          if (A < 6) continue;
          let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
          for (const i of cells) { const c = i % w, r = (i - c) / w; if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r; }
          const diag = Math.hypot(c1 - c0 + 1, r1 - r0 + 1) * res;
          const hs = cells.map((i) => chmS[i]).filter(valid);
          let isHaie = false;
          if (o.haies && A / diag <= 6 && A <= 4000) {
            const sk = skeletonOf(cells, g);
            if (sk.length >= 8 && A / sk.length <= 5) {
              isHaie = true;
              const paths = sk.paths.filter((p) => p.length >= 2 && polyLength(p) >= 2).map((p) => T.simplify(chaikin(p, 2, false), 0.2));
              if (paths.length) add({ kind: 'haie', source: 'lidar', paths, h: quantile(hs, 0.8), len: sk.length });
            }
          }
          if (!isHaie && o.massifs && A >= 250) {
            const pad = 2, cw = c1 - c0 + 1 + 2 * pad, ch = r1 - r0 + 1 + 2 * pad;
            const sub = { xmin: g.xmin + (c0 - pad) * res, ymax: g.ymax - (r0 - pad) * res, res, w: cw, h: ch, data: new Float32Array(cw * ch) };
            for (const i of cells) { const c = i % w, r = (i - c) / w; sub.data[(r - r0 + pad) * cw + (c - c0 + pad)] = 1; }
            const sm = T.smoothGrid(sub, 1);
            const rings = T.contours(sm, 1, { levels: [0.5], simplify: 0.3 })
              .filter((l) => l.closed && polyLength(l.coords) >= 20)
              .map((l) => l.coords.slice(0, -1));
            if (rings.length) add({ kind: 'massif', rings, h: median(hs), area: A });
          }
        }
      }

      // Murs et clôtures : structures fines de 0,5 à 4 m de haut
      if (o.murs) {
        progress(0.72, 'Murs et clôtures');
        await tick();
        const M = new Uint8Array(N);
        for (let i = 0; i < N; i++) M[i] = chm[i] >= 0.5 && chm[i] <= 4 && vzone(i) && owner[i] < 0 ? 1 : 0;
        const open = dilate(erode(M, w, h, 1), w, h, 1);
        const thinM = new Uint8Array(N);
        for (let i = 0; i < N; i++) thinM[i] = M[i] && !open[i] ? 1 : 0;
        const cc = components(thinM, w, h);
        for (const cells of cc.cells) {
          if (cells.length < 6) continue;
          const sk = skeletonOf(cells, g);
          const A = cells.length * res * res;
          if (sk.length < 4 || A / sk.length > 1.2) continue;
          const hs = cells.map((i) => chm[i]).filter(valid);
          const hm = median(hs);
          const mean = hs.reduce((a, v) => a + v, 0) / hs.length;
          const sd = Math.sqrt(hs.reduce((a, v) => a + (v - mean) * (v - mean), 0) / hs.length);
          if (!(hm >= 0.6 && hm <= 3.0) || sd > 0.45) continue;
          for (const p of sk.paths) {
            if (p.length < 2 || polyLength(p) < 3) continue;
            const c2 = T.simplify(chaikin(p, 1, false), 0.15).map((q) => [q[0], q[1], T.sample(g, q[0], q[1])]);
            add({ kind: 'mur', source: 'lidar', coords: c2, h: hm });
          }
        }
      }
    }

    /* ---------------- Données IGN complémentaires ---------------- */
    if (o.haies && input.haiesIgn) {
      for (const f of input.haiesIgn) {
        const paths = [];
        T.eachPart(f.geometry, (coords) => { if (coords.length >= 2) paths.push(coords.map((q) => [q[0], q[1]])); });
        if (paths.length) add({ kind: 'haie', source: 'ign', paths, h: NaN });
      }
    }
    if (o.constructions && input.constructions) {
      for (const f of input.constructions) {
        const nature = (f.properties && f.properties.nature) || 'Construction';
        T.eachPart(f.geometry, (coords) => {
          if (coords.length < 2) return;
          let hm = NaN;
          if (chm) {
            const hs = [];
            const L = polyLength(coords);
            for (let s = 0; s <= L; s += 1) {
              const q = pointAt(coords, s);
              let best = -Infinity;
              for (const [ox, oy] of [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) {
                const ci = cellAt(g, q.x + ox, q.y + oy); if (ci >= 0 && valid(chm[ci]) && chm[ci] > best) best = chm[ci];
              }
              if (best > -Infinity) hs.push(best);
            }
            hm = median(hs);
          }
          add({ kind: 'constr', nature, coords: coords.map((q) => [q[0], q[1], T.sample(g, q[0], q[1])]), h: hm });
        });
      }
    }

    /* ---------------- Cotes des bâtiments ---------------- */
    if (o.batCotes) {
      progress(0.82, 'Cotes des bâtiments');
      await tick();
      for (const f of input.buildings || []) {
        T.eachPart(f.geometry, (coords, closed) => {
          if (!closed || coords.length < 4) return;
          const rg = T.stripClosing(coords);
          const lp = T.labelPoint(rg);
          if (!T.inZone(lp[0], lp[1], ring, margin)) return;
          let pied = Infinity;
          for (let k = 0; k < rg.length; k++) {
            const a = rg[k], b = rg[(k + 1) % rg.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (!L) continue;
            const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L;
            for (let s = 0.5; s < L; s += 1) {
              const x = a[0] + tx * s, y = a[1] + ty * s;
              for (const sg of [1, -1]) {
                const px = x - ty * sg, py = y + tx * sg;
                if (T.pointInRing(px, py, rg)) continue;
                const z = T.sample(g, px, py); if (valid(z) && z < pied) pied = z;
              }
            }
          }
          let fait = -Infinity;
          if (mns) {
            const bb = T.ringBBox(rg, 0);
            for (let y = bb[1] + res / 2; y < bb[3]; y += res) {
              for (let x = bb[0] + res / 2; x < bb[2]; x += res) {
                if (!T.pointInRing(x, y, rg)) continue;
                const ci = cellAt(g, x, y); if (ci < 0) continue;
                const z = mns.data[ci]; if (valid(z) && z > fait) fait = z;
              }
            }
          }
          const p = f.properties || {};
          const hAttr = Number(p.hauteur) > 0 ? Number(p.hauteur) : NaN;
          const hh = fait > -Infinity && pied < Infinity ? fait - pied : hAttr;
          const et = Number(p.nombre_d_etages) > 0 ? Number(p.nombre_d_etages) : 0;
          const lines = [];
          if (valid(hh)) lines.push('h ' + hh.toFixed(1) + ' m' + (et ? ' · R+' + (et - 1) : ''));
          if (fait > -Infinity) lines.push('Faît. ' + fait.toFixed(2));
          if (pied < Infinity) lines.push('Pied ' + pied.toFixed(2));
          if (lines.length) add({ kind: 'batiment', x: lp[0], y: lp[1], z: pied < Infinity ? pied : 0, lines, h: hh, ring: rg });
        });
      }
    }
    progress(1, 'Plan détaillé prêt');
    return { items, res, sensi: o.sensi, hmin };
  }

  /* ------------------------------------------------------------------ */
  /* Calques, comptages, sélection                                       */
  /* ------------------------------------------------------------------ */

  const KIND_KEY = { talus: 'talus', fosse: 'fosses', crete: 'cretes', extreme: 'extremes', arbre: 'arbres', haie: 'haies', massif: 'massifs', mur: 'murs', constr: 'constructions', batiment: 'batCotes' };

  function count(plan, key) {
    if (!plan) return 0;
    let n = 0;
    for (const it of plan.items) if (!it.deleted && KIND_KEY[it.kind] === key) n++;
    return n;
  }

  /** Élément le plus proche de (x, y) à moins de tol mètres, parmi les calques affichés. */
  function hitTest(plan, x, y, tol, isOn) {
    let best = null, bd = Infinity;
    for (const it of plan.items) {
      if (it.deleted || !isOn(KIND_KEY[it.kind])) continue;
      let d = Infinity;
      switch (it.kind) {
        case 'arbre': d = Math.max(0, Math.hypot(it.x - x, it.y - y) - it.d / 2); break;
        case 'extreme': case 'batiment': d = Math.hypot(it.x - x, it.y - y); break;
        case 'talus': for (const l of it.lines) d = Math.min(d, distToPoly(x, y, l.coords, false)); break;
        case 'fosse': case 'crete': case 'mur': case 'constr': d = distToPoly(x, y, it.coords, false); break;
        case 'haie': for (const p of it.paths) d = Math.min(d, distToPoly(x, y, p, false)); break;
        case 'massif': for (const r of it.rings) d = Math.min(d, distToPoly(x, y, r, true)); break;
      }
      if (it.kind === 'arbre') d = Math.max(0, d - tol * 0.5);
      if (d <= tol && d < bd) { bd = d; best = it; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Écriture DXF                                                        */
  /* ------------------------------------------------------------------ */

  const L = {
    TALUS_CRETE: ['TN_TALUS_CRETE', 30], TALUS_PIED: ['TN_TALUS_PIED', 32], TALUS_BARB: ['TN_TALUS_BARBULES', 30], TALUS_TXT: ['TN_TALUS_TEXTE', 30],
    FOSSE: ['TN_FOSSES_NOUES', 5], FOSSE_FE: ['TN_FOSSES_FIL_EAU', 5], FOSSE_SENS: ['TN_FOSSES_SENS', 5],
    CRETE: ['TN_LIGNES_CRETE', 34, 'TIRETS'],
    EXT: ['TN_POINTS_HAUTS_BAS', 6],
    ARBRE: ['VEG_ARBRES', 3], ARBRE_TRONC: ['VEG_ARBRES_TRONC', 3], ARBRE_TXT: ['VEG_ARBRES_TEXTE', 3],
    HAIE: ['VEG_HAIES_LIDAR', 82], HAIE_IGN: ['VEG_HAIES_IGN', 84], HAIE_TXT: ['VEG_HAIES_TEXTE', 82],
    MASSIF: ['VEG_MASSIFS_BOISES', 82, 'TIRETS'], MASSIF_TXT: ['VEG_MASSIFS_TEXTE', 82],
    MUR: ['OUV_MURS_CLOTURES_LIDAR', 8], MUR_TXT: ['OUV_MURS_TEXTE', 8], CONSTR: ['OUV_CONSTRUCTIONS_IGN', 9],
    BAT: ['BAT_COTES', 7],
    CARTOUCHE: ['CARTOUCHE', 7], LEGENDE: ['LEGENDE', 7], NORD: ['NORD', 7], QUADRILLAGE: ['QUADRILLAGE', 8],
  };

  /** Bloc « houppier » : cercle festonné de rayon 1, mis à l'échelle à l'insertion. */
  function treeBlock() {
    const n = 64, v = [];
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n, r = 0.86 + 0.14 * Math.abs(Math.sin(4 * a));
      v.push('0\nVERTEX\n8\n0\n10\n' + (r * Math.cos(a)).toFixed(4) + '\n20\n' + (r * Math.sin(a)).toFixed(4) + '\n30\n0.0');
    }
    return ['0\nPOLYLINE\n8\n0\n66\n1\n10\n0.0\n20\n0.0\n30\n0.0\n70\n1\n' + v.join('\n') + '\n0\nSEQEND\n8\n0'];
  }

  function textOff(dxf, lb, off, h, layer, z) {
    const x = lb.x + (lb.nx || 0) * off, y = lb.y + (lb.ny || 0) * off;
    dxf.text(x, y, z || 0, h, lb.text, layer, lb.rot || 0, 'center', 0.85);
  }

  function arrow(dxf, x, y, z, dx, dy, s, layer) {
    // pointe de flèche orientée selon (dx, dy)
    const a = Math.atan2(dy, dx), b = 25 * Math.PI / 180;
    for (const sg of [1, -1]) dxf.line([x, y, z], [x - s * Math.cos(a + sg * b), y - s * Math.sin(a + sg * b), z], layer);
    dxf.line([x - 1.6 * s * Math.cos(a), y - 1.6 * s * Math.sin(a), z], [x, y, z], layer);
  }

  /**
   * Écrit les calques du plan détaillé.
   * o = { on(key), th (hauteur de texte), scale, layout: { zoneBB, commune, dates, version, date, base: [[label, kind]] } }
   */
  function writeDXF(dxf, plan, o) {
    const th = o.th, ts = th * 0.8;
    for (const k in L) dxf.layer(L[k][0], L[k][1], L[k][2]);
    dxf.ltscale = Math.max(0.2, o.scale / 500);
    const on = (k) => o.on(k);
    let treeBlockDone = false;
    for (const it of plan.items) {
      if (it.deleted || !on(KIND_KEY[it.kind])) continue;
      switch (it.kind) {
        case 'talus':
          for (const l of it.lines) dxf.poly3d(l.coords, false, l.type === 'crete' ? L.TALUS_CRETE[0] : L.TALUS_PIED[0]);
          for (const b of it.barbules) dxf.line(b[0], b[1], L.TALUS_BARB[0]);
          if (it.label) textOff(dxf, it.label, -th * 1.2, ts, L.TALUS_TXT[0]);
          break;
        case 'fosse': {
          dxf.poly3d(it.coords, false, L.FOSSE[0]);
          for (const lb of it.labels) { textOff(dxf, lb, th * 1.0, ts, L.FOSSE_FE[0], lb.z); }
          if (it.flow) {
            const len = polyLength(it.coords);
            const q = pointAt(it.coords, len / 2);
            const mid = it.coords[Math.floor(it.coords.length / 2)];
            const zq = mid && valid(mid[2]) ? mid[2] : 0;
            arrow(dxf, q.x, q.y, zq, q.dx * it.flow, q.dy * it.flow, th * 1.2, L.FOSSE_SENS[0]);
          }
          break;
        }
        case 'crete': dxf.poly3d(it.coords, false, L.CRETE[0]); break;
        case 'extreme': {
          const s = th * 0.7, up = it.type === 'haut' ? 1 : -1;
          dxf.point(it.x, it.y, it.z, L.EXT[0]);
          dxf.poly2d([[it.x - s, it.y - up * s * 0.6], [it.x + s, it.y - up * s * 0.6], [it.x, it.y + up * s * 1.1]], true, L.EXT[0], it.z);
          dxf.text(it.x + s * 1.4, it.y - ts / 2, it.z, ts, (it.type === 'haut' ? 'PH ' : 'PB ') + it.z.toFixed(2), L.EXT[0]);
          break;
        }
        case 'arbre':
          if (!treeBlockDone) { dxf.block('EXT_HOUPPIER', treeBlock()); treeBlockDone = true; }
          dxf.insert('EXT_HOUPPIER', it.x, it.y, it.z, Math.max(0.5, it.d / 2), L.ARBRE[0]);
          dxf.circle(it.x, it.y, it.z, Math.max(0.1, Math.min(0.3, it.d * 0.03)), L.ARBRE_TRONC[0]);
          dxf.text(it.x, it.y - Math.min(it.d / 2, th * 3) * 0.35, it.z, ts * 0.9, 'h' + Math.round(it.h) + ' Ø' + Math.round(it.d), L.ARBRE_TXT[0], 0, 'center', 0.85);
          break;
        case 'haie':
          for (const p of it.paths) dxf.poly2d(p, false, it.source === 'ign' ? L.HAIE_IGN[0] : L.HAIE[0], 0);
          if (it.source !== 'ign' && it.paths[0] && valid(it.h)) {
            const longest = it.paths.slice().sort((a, b) => polyLength(b) - polyLength(a))[0];
            const q = pointAt(longest, polyLength(longest) / 2);
            textOff(dxf, { x: q.x, y: q.y, rot: readableAngle(q.dx, q.dy), nx: -q.dy, ny: q.dx, text: 'Haie h ' + it.h.toFixed(1) }, th * 1.2, ts, L.HAIE_TXT[0]);
          }
          break;
        case 'massif': {
          for (const r of it.rings) dxf.poly2d(r, true, L.MASSIF[0], 0);
          const lp = T.labelPoint(it.rings[0]);
          dxf.text(lp[0], lp[1], 0, th, 'Massif boisé' + (valid(it.h) ? ' h ' + it.h.toFixed(0) + ' m' : ''), L.MASSIF_TXT[0], 0, 'center', 0.85);
          break;
        }
        case 'mur': {
          dxf.poly3d(it.coords, false, L.MUR[0]);
          const q = pointAt(it.coords, polyLength(it.coords) / 2);
          textOff(dxf, { x: q.x, y: q.y, rot: readableAngle(q.dx, q.dy), nx: -q.dy, ny: q.dx, text: 'Mur/clôture h ' + it.h.toFixed(1) }, th * 0.9, ts * 0.9, L.MUR_TXT[0]);
          break;
        }
        case 'constr': {
          dxf.poly3d(it.coords, false, L.CONSTR[0]);
          const q = pointAt(it.coords, polyLength(it.coords) / 2);
          textOff(dxf, { x: q.x, y: q.y, rot: readableAngle(q.dx, q.dy), nx: -q.dy, ny: q.dx, text: it.nature + (valid(it.h) && it.h > 0.3 ? ' h ' + it.h.toFixed(1) : '') }, th * 0.9, ts * 0.9, L.MUR_TXT[0]);
          break;
        }
        case 'batiment':
          it.lines.forEach((s, k) => dxf.text(it.x, it.y - k * ts * 1.5 + (it.lines.length - 1) * ts * 0.75, it.z, ts, s, L.BAT[0], 0, 'center', 0.85));
          break;
      }
    }
    if (o.layout) writeLayout(dxf, plan, o);
  }

  /* ---------------- Mise en page : cartouche, légende, nord, quadrillage ---------------- */

  function rect(dxf, x0, y0, x1, y1, layer) { dxf.poly2d([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true, layer, 0); }

  function writeLayout(dxf, plan, o) {
    const lay = o.layout, k = o.scale / 1000; // mètres par millimètre papier
    const bb = lay.zoneBB;
    const on = (key) => o.on(key);
    const X0 = bb[2] + 15 * k, Ytop = bb[3];

    if (on('quadrillage')) {
      const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500];
      let st = steps.find((s) => s >= 40 * k) || 500;
      while (((bb[2] - bb[0]) / st) * ((bb[3] - bb[1]) / st) > 2500) st *= 2;
      const Lq = L.QUADRILLAGE[0], a = 2 * k, hT = 2 * k;
      rect(dxf, bb[0], bb[1], bb[2], bb[3], Lq);
      const fmtN = (v) => Math.round(v).toLocaleString('fr-FR').replace(/ | /g, ' ');
      for (let x = Math.ceil(bb[0] / st) * st; x <= bb[2]; x += st) {
        for (let y = Math.ceil(bb[1] / st) * st; y <= bb[3]; y += st) {
          dxf.line([x - a, y], [x + a, y], Lq); dxf.line([x, y - a], [x, y + a], Lq);
        }
        dxf.line([x, bb[1]], [x, bb[1] - 2 * k], Lq);
        dxf.text(x, bb[1] - 5 * k, 0, hT, 'X ' + fmtN(x), Lq, 0, 'center', 0.85);
      }
      for (let y = Math.ceil(bb[1] / st) * st; y <= bb[3]; y += st) {
        dxf.line([bb[0], y], [bb[0] - 2 * k, y], Lq);
        dxf.text(bb[0] - 5 * k, y, 0, hT, 'Y ' + fmtN(y), Lq, 90, 'center', 0.85);
      }
    }

    let y = Ytop;
    if (on('nord')) {
      const Ln = L.NORD[0], cx = X0 + 12 * k;
      const yb = y - 26 * k, yt = y - 6 * k;
      dxf.line([cx, yb], [cx, yt], Ln);
      dxf.poly2d([[cx, yt + 2 * k], [cx - 3 * k, yt - 4 * k], [cx, yt - 2.5 * k], [cx + 3 * k, yt - 4 * k]], true, Ln, 0);
      dxf.text(cx, y - 2.5 * k, 0, 4 * k, 'N', Ln, 0, 'center');
      y -= 32 * k;
    }

    if (on('cartouche')) {
      const Lc = L.CARTOUCHE[0], W = 140 * k, pad = 3 * k;
      const rows = [
        [5, 'PLAN DU TERRAIN NATUREL'],
        [2.5, 'Établi à partir de données publiques IGN — non levé sur site'],
        [3, (lay.commune || 'Commune non déterminée')],
        [2.5, 'Échelle 1/' + o.scale + ' — Export du ' + lay.date],
        [2.5, 'RGF93 v1 / Lambert-93 (EPSG:2154) — Altitudes NGF-IGN69'],
      ];
      for (const s of lay.dates || []) rows.push([2.2, s]);
      rows.push([2.2, 'Sources : IGN — LiDAR HD, BD TOPO, Parcellaire Express, BD ORTHO'], [2.2, 'Licence Ouverte Etalab 2.0 — « Source : IGN »'], [2.2, 'ExporTopo v' + lay.version + ' — By CHB']);
      const H = rows.reduce((a, r) => a + r[0] * 1.8 * k, 0) + 2 * pad;
      rect(dxf, X0, y - H, X0 + W, y, Lc);
      let cy = y - pad;
      rows.forEach((r, i) => {
        cy -= r[0] * 1.8 * k;
        dxf.text(X0 + pad, cy + r[0] * 0.4 * k, 0, r[0] * k, r[1], Lc, 0, 'left', 0.85);
        if (i === 0) dxf.line([X0, cy - 0.4 * k], [X0 + W, cy - 0.4 * k], Lc);
      });
      y -= H + 8 * k;
    }

    if (on('legende')) {
      const Ll = L.LEGENDE[0], rowH = 7 * k, sx = X0 + 3 * k, sw = 16 * k, tx = X0 + 23 * k, hT = 2.5 * k;
      const entries = [];
      const has = (key) => count(plan, key) > 0 && on(key);
      for (const b of lay.base || []) entries.push(b);
      if (has('talus')) entries.push(['Talus (crête, pied, barbules)', 'talus']);
      if (has('fosses')) entries.push(['Fossé / noue, sens d\'écoulement, fil d\'eau', 'fosse']);
      if (has('cretes')) entries.push(['Ligne de crête', 'crete']);
      if (has('extremes')) entries.push(['Point haut / point bas', 'extreme']);
      if (has('arbres')) entries.push(['Arbre (hauteur, diamètre du houppier)', 'arbre']);
      if (has('haies')) entries.push(['Haie', 'haie']);
      if (has('massifs')) entries.push(['Massif boisé', 'massif']);
      if (has('murs')) entries.push(['Mur ou clôture détecté (indicatif)', 'mur']);
      if (has('constructions')) entries.push(['Construction linéaire IGN (mur, clôture…)', 'constr']);
      if (!entries.length) return;
      dxf.text(X0, y - 4 * k, 0, 3.5 * k, 'LÉGENDE', Ll, 0, 'left', 0.85);
      y -= 9 * k;
      const top = y + 3 * k;
      for (const [label, kind] of entries) {
        const cy = y - rowH / 2;
        switch (kind) {
          case 'talus':
            dxf.line([sx, cy + 2 * k], [sx + sw, cy + 2 * k], Ll);
            for (let i = 0; i < 6; i++) dxf.line([sx + (i + 0.5) * sw / 6, cy + 2 * k], [sx + (i + 0.5) * sw / 6, cy + 2 * k - (i % 2 ? 2 : 4) * k], Ll);
            break;
          case 'fosse': dxf.line([sx, cy], [sx + sw, cy], Ll); arrow(dxf, sx + sw * 0.6, cy, 0, 1, 0, 2 * k, Ll); break;
          case 'crete': for (let i = 0; i < 4; i++) dxf.line([sx + i * 4 * k, cy], [sx + i * 4 * k + 2.5 * k, cy], Ll); break;
          case 'extreme': dxf.poly2d([[sx + 6 * k, cy - 1.5 * k], [sx + 10 * k, cy - 1.5 * k], [sx + 8 * k, cy + 2 * k]], true, Ll, 0); break;
          case 'arbre':
            if (count(plan, 'arbres')) dxf.insert('EXT_HOUPPIER', sx + sw / 2, cy, 0, 3 * k, Ll);
            dxf.circle(sx + sw / 2, cy, 0, 0.4 * k, Ll);
            break;
          case 'massif': for (let i = 0; i < 4; i++) dxf.line([sx + i * 4 * k, cy], [sx + i * 4 * k + 2.5 * k, cy], Ll); break;
          case 'point': dxf.line([sx + 7 * k, cy - k], [sx + 9 * k, cy + k], Ll); dxf.line([sx + 7 * k, cy + k], [sx + 9 * k, cy - k], Ll); break;
          default: dxf.line([sx, cy], [sx + sw, cy], Ll);
        }
        dxf.text(tx, cy - hT / 2, 0, hT, label, Ll, 0, 'left', 0.85);
        y -= rowH;
      }
      rect(dxf, X0, y - 2 * k, X0 + 140 * k, top + 6 * k, Ll);
    }
  }

  /* ------------------------------------------------------------------ */
  /* GeoJSON et tableau des arbres                                        */
  /* ------------------------------------------------------------------ */

  const r3 = (v) => Math.round(v * 1000) / 1000;

  function toFeatures(plan, isOn) {
    const out = {};
    const push = (name, f) => { (out[name] = out[name] || []).push(f); };
    for (const it of plan.items) {
      if (it.deleted || !isOn(KIND_KEY[it.kind])) continue;
      const line = (c) => ({ type: 'LineString', coordinates: c.map((q) => q.map(r3)) });
      switch (it.kind) {
        case 'talus': for (const l of it.lines) push('talus', { type: 'Feature', properties: { type: l.type, hauteur: valid(it.h) ? r3(it.h) : null }, geometry: line(l.coords) }); break;
        case 'fosse': push('fosses_noues', { type: 'Feature', properties: { longueur: r3(it.len), sens: it.flow }, geometry: line(it.coords) }); break;
        case 'crete': push('lignes_crete', { type: 'Feature', properties: {}, geometry: line(it.coords) }); break;
        case 'extreme': push('points_hauts_bas', { type: 'Feature', properties: { type: it.type, z: r3(it.z) }, geometry: { type: 'Point', coordinates: [r3(it.x), r3(it.y), r3(it.z)] } }); break;
        case 'arbre': push('arbres', { type: 'Feature', properties: { hauteur: r3(it.h), diametre_houppier: r3(it.d), z_sol: r3(it.z) }, geometry: { type: 'Point', coordinates: [r3(it.x), r3(it.y), r3(it.z)] } }); break;
        case 'haie': for (const p of it.paths) push('haies', { type: 'Feature', properties: { source: it.source, hauteur: valid(it.h) ? r3(it.h) : null }, geometry: line(p) }); break;
        case 'massif': push('massifs_boises', { type: 'Feature', properties: { hauteur: valid(it.h) ? r3(it.h) : null, surface: Math.round(it.area) }, geometry: { type: 'Polygon', coordinates: it.rings.map((r) => r.concat([r[0]]).map((q) => q.map(r3))) } }); break;
        case 'mur': push('murs_clotures_lidar', { type: 'Feature', properties: { hauteur: r3(it.h) }, geometry: line(it.coords) }); break;
        case 'constr': push('constructions_lineaires', { type: 'Feature', properties: { nature: it.nature, hauteur: valid(it.h) ? r3(it.h) : null }, geometry: line(it.coords) }); break;
        case 'batiment': push('batiments_cotes', { type: 'Feature', properties: { cotes: it.lines.join(' / '), hauteur: valid(it.h) ? r3(it.h) : null }, geometry: { type: 'Point', coordinates: [r3(it.x), r3(it.y)] } }); break;
      }
    }
    return out;
  }

  /** « matricule X Y Z hauteur diamètre », un arbre par ligne. */
  function treesTxt(plan) {
    const lines = [];
    let n = 1;
    for (const it of plan.items) {
      if (it.kind !== 'arbre' || it.deleted) continue;
      lines.push(n++ + ' ' + it.x.toFixed(3) + ' ' + it.y.toFixed(3) + ' ' + it.z.toFixed(3) + ' ' + it.h.toFixed(1) + ' ' + it.d.toFixed(1));
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
  }

  return { SENSI, analyse, count, hitTest, writeDXF, toFeatures, treesTxt, KIND_KEY, LAYERS: L, polyLength, pointAt, readableAngle,
    _internal: { dilate, erode, components, thin, traceSkeleton, boxMean, extremeFilter, skeletonOf, chaikin } };
});
