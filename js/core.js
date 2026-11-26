/*!
 * ExporTopo — moteur de calcul (aucune dépendance, testable sous Node).
 * Grilles altimétriques, échantillonnage des points TN, courbes de niveau,
 * TIN, et écriture des formats DXF R12, CSV, LandXML 1.2, ASC, GeoJSON.
 * Licence MIT.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TopoCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Numéro de version unique (interface, LandXML, LISEZMOI). À incrémenter à chaque modification. */
  const VERSION = '1.4';
  const NODATA = -99999;

  function isValid(z) {
    return z === z && z > -1000 && z < 9000;
  }

  /* ------------------------------------------------------------------ */
  /* Géométrie                                                           */
  /* ------------------------------------------------------------------ */

  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function distToSegment2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx - px, ey = ay + t * dy - py;
    return ex * ex + ey * ey;
  }

  /** Vrai si (x,y) est dans l'anneau, ou à moins de `margin` mètres de son bord. */
  function inZone(x, y, ring, margin) {
    if (pointInRing(x, y, ring)) return true;
    if (!margin) return false;
    const m2 = margin * margin;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (distToSegment2(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]) <= m2) return true;
    }
    return false;
  }

  function ringArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    }
    return Math.abs(a) / 2;
  }

  function ringBBox(ring, margin) {
    margin = margin || 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ring) {
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
    return [x0 - margin, y0 - margin, x1 + margin, y1 + margin];
  }

  function ringCentroid(ring) {
    let a = 0, cx = 0, cy = 0;
    const ox = ring[0][0], oy = ring[0][1];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0] - ox, yi = ring[i][1] - oy, xj = ring[j][0] - ox, yj = ring[j][1] - oy;
      const f = xj * yi - xi * yj;
      a += f;
      cx += (xj + xi) * f;
      cy += (yj + yi) * f;
    }
    if (Math.abs(a) < 1e-9) return [ring[0][0], ring[0][1]];
    return [cx / (3 * a) + ox, cy / (3 * a) + oy];
  }

  /** Point garanti dans le polygone (centroïde, sinon balayage horizontal). */
  function labelPoint(ring) {
    const c = ringCentroid(ring);
    if (pointInRing(c[0], c[1], ring)) return c;
    const y = c[1];
    const xs = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][1], yj = ring[j][1];
      if ((yi > y) !== (yj > y)) xs.push(ring[i][0] + ((y - yi) * (ring[j][0] - ring[i][0])) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    let best = null, bw = -1;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      if (xs[k + 1] - xs[k] > bw) { bw = xs[k + 1] - xs[k]; best = [(xs[k] + xs[k + 1]) / 2, y]; }
    }
    return best || c;
  }

  /** Simplification Douglas-Peucker (coordonnées 2D ou 3D, tolérance en plan). */
  function simplify(coords, tol) {
    if (coords.length <= 2 || !tol) return coords;
    const t2 = tol * tol;
    const keep = new Uint8Array(coords.length);
    keep[0] = keep[coords.length - 1] = 1;
    const stack = [[0, coords.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = distToSegment2(coords[i][0], coords[i][1], coords[a][0], coords[a][1], coords[b][0], coords[b][1]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > t2) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    const out = [];
    for (let i = 0; i < coords.length; i++) if (keep[i]) out.push(coords[i]);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Grilles                                                             */
  /* Une grille : { xmin, ymax, res, w, h, data: Float32Array }          */
  /* Le pixel (c, r) a son centre en (xmin+(c+.5)res, ymax-(r+.5)res).   */
  /* ------------------------------------------------------------------ */

  function makeGrid(xmin, ymax, res, w, h, fill) {
    const data = new Float32Array(w * h);
    if (fill !== undefined) data.fill(fill);
    return { xmin, ymax, res, w, h, data };
  }

  function gridStats(g) {
    let n = 0, min = Infinity, max = -Infinity;
    for (let i = 0; i < g.data.length; i++) {
      const z = g.data[i];
      if (isValid(z)) { n++; if (z < min) min = z; if (z > max) max = z; }
    }
    return { valid: n, total: g.data.length, coverage: g.data.length ? n / g.data.length : 0, min, max };
  }

  /** Remplit les trous de `g` avec les valeurs de `fallback` (même emprise, même taille). */
  function fillGaps(g, fallback) {
    let filled = 0;
    for (let i = 0; i < g.data.length; i++) {
      if (!isValid(g.data[i]) && isValid(fallback.data[i])) { g.data[i] = fallback.data[i]; filled++; }
    }
    return filled;
  }

  /** Altitude interpolée (bilinéaire) en (x, y). NaN hors données. */
  function sample(g, x, y) {
    const fc = (x - g.xmin) / g.res - 0.5;
    const fr = (g.ymax - y) / g.res - 0.5;
    if (fc < -0.5 || fr < -0.5 || fc > g.w - 0.5 || fr > g.h - 0.5) return NaN;
    let c0 = Math.floor(fc), r0 = Math.floor(fr);
    if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0;
    if (c0 > g.w - 2) c0 = Math.max(0, g.w - 2);
    if (r0 > g.h - 2) r0 = Math.max(0, g.h - 2);
    const c1 = Math.min(c0 + 1, g.w - 1), r1 = Math.min(r0 + 1, g.h - 1);
    let tx = fc - c0, ty = fr - r0;
    tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;
    ty = ty < 0 ? 0 : ty > 1 ? 1 : ty;
    const v = [g.data[r0 * g.w + c0], g.data[r0 * g.w + c1], g.data[r1 * g.w + c0], g.data[r1 * g.w + c1]];
    const wts = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
    let s = 0, sw = 0;
    for (let k = 0; k < 4; k++) if (isValid(v[k])) { s += v[k] * wts[k]; sw += wts[k]; }
    return sw > 0.25 ? s / sw : NaN;
  }

  /** Lissage par moyenne glissante 3x3, `passes` fois, en ignorant les trous. */
  function smoothGrid(g, passes) {
    let src = g.data;
    const w = g.w, h = g.h;
    for (let p = 0; p < passes; p++) {
      const dst = new Float32Array(src.length);
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const i = r * w + c;
          if (!isValid(src[i])) { dst[i] = NaN; continue; }
          let s = 0, n = 0;
          for (let dr = -1; dr <= 1; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= h) continue;
            for (let dc = -1; dc <= 1; dc++) {
              const cc = c + dc;
              if (cc < 0 || cc >= w) continue;
              const z = src[rr * w + cc];
              if (isValid(z)) { s += z; n++; }
            }
          }
          dst[i] = s / n;
        }
      }
      src = dst;
    }
    return { xmin: g.xmin, ymax: g.ymax, res: g.res, w, h, data: src };
  }

  /** Sous-échantillonnage par facteur entier (moyenne des pixels valides). */
  function downsample(g, factor) {
    factor = Math.max(1, Math.round(factor));
    if (factor === 1) return g;
    const w = Math.floor(g.w / factor), h = Math.floor(g.h / factor);
    const out = makeGrid(g.xmin, g.ymax, g.res * factor, w, h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        let s = 0, n = 0;
        for (let dr = 0; dr < factor; dr++) {
          const base = (r * factor + dr) * g.w + c * factor;
          for (let dc = 0; dc < factor; dc++) {
            const z = g.data[base + dc];
            if (isValid(z)) { s += z; n++; }
          }
        }
        out.data[r * w + c] = n ? s / n : NaN;
      }
    }
    return out;
  }

  /** Copie de la grille où les pixels hors zone (+ marge) deviennent NaN. */
  function maskGrid(g, ring, margin) {
    const out = { xmin: g.xmin, ymax: g.ymax, res: g.res, w: g.w, h: g.h, data: new Float32Array(g.data) };
    const bb = ringBBox(ring, margin);
    for (let r = 0; r < g.h; r++) {
      const y = g.ymax - (r + 0.5) * g.res;
      for (let c = 0; c < g.w; c++) {
        const x = g.xmin + (c + 0.5) * g.res;
        const i = r * g.w + c;
        if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3] || !inZone(x, y, ring, margin)) out.data[i] = NaN;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Points TN                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Semis régulier de points calé sur des coordonnées rondes (multiples du pas).
   * Retourne [{ id, x, y, z, i, j }] où (i, j) est la position dans le semis.
   */
  function samplePoints(g, opts) {
    const step = opts.step;
    const ring = opts.ring;
    const margin = opts.margin || 0;
    const bb = ringBBox(ring, margin);
    const i0 = Math.ceil(bb[0] / step), i1 = Math.floor(bb[2] / step);
    const j0 = Math.ceil(bb[1] / step), j1 = Math.floor(bb[3] / step);
    const pts = [];
    let id = opts.start || 1;
    // Numérotation de l'ouest vers l'est, du nord vers le sud (lecture naturelle d'un plan).
    for (let j = j1; j >= j0; j--) {
      const y = j * step;
      for (let i = i0; i <= i1; i++) {
        const x = i * step;
        if (!inZone(x, y, ring, margin)) continue;
        const z = sample(g, x, y);
        if (!isValid(z)) continue;
        pts.push({ id: id++, x, y, z, i: i - i0, j: j1 - j });
      }
    }
    return { points: pts, cols: i1 - i0 + 1, rows: j1 - j0 + 1, x0: i0 * step, y1: j1 * step, step };
  }

  /**
   * Triangulation du semis régulier (2 triangles par maille, 1 si un sommet manque).
   * Retourne un Int32Array plat [a0,b0,c0, a1,b1,c1, …] d'indices dans semis.points (économe en mémoire).
   */
  function gridTIN(semis, ring, margin) {
    const { points, cols, rows, x0, y1, step } = semis;
    const index = new Int32Array(cols * rows).fill(-1);
    points.forEach((p, k) => { index[p.j * cols + p.i] = k; });
    let buf = new Int32Array(Math.max(6, points.length * 6));
    let n = 0;
    const faces = {
      push() {
        for (let q = 0; q < arguments.length; q++) {
          const f = arguments[q];
          if (n + 3 > buf.length) { const nb = new Int32Array(buf.length * 2); nb.set(buf); buf = nb; }
          buf[n++] = f[0]; buf[n++] = f[1]; buf[n++] = f[2];
        }
      },
    };
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = index[j * cols + i], b = index[j * cols + i + 1];
        const c = index[(j + 1) * cols + i + 1], d = index[(j + 1) * cols + i];
        const cx = x0 + (i + 0.5) * step, cy = y1 - (j + 0.5) * step;
        if (ring && !inZone(cx, cy, ring, margin)) continue;
        const nv = (a >= 0) + (b >= 0) + (c >= 0) + (d >= 0);
        if (nv === 4) {
          // Diagonale la plus courte en 3D, pour mieux suivre talus et fossés.
          const pa = points[a], pb = points[b], pc = points[c], pd = points[d];
          if (Math.abs(pa.z - pc.z) <= Math.abs(pb.z - pd.z)) { faces.push([a, b, c], [a, c, d]); }
          else { faces.push([a, b, d], [b, c, d]); }
        } else if (nv === 3) {
          faces.push([a, b, c, d].filter((v) => v >= 0));
        }
      }
    }
    return buf.slice(0, n);
  }

  /* ------------------------------------------------------------------ */
  /* Courbes de niveau (marching squares sur les centres de pixels)     */
  /* ------------------------------------------------------------------ */

  function contours(g, interval, opts) {
    opts = opts || {};
    const master = opts.masterEvery || 5;
    const tol = opts.simplify === undefined ? g.res * 0.25 : opts.simplify;
    const w = g.w, h = g.h, d = g.data;
    const buckets = new Map(); // niveau k -> tableau plat [e1, e2, e1, e2, ...]
    const eps = 1e-9;
    const lv = opts.levels || null;          // niveaux explicites (au lieu d'une équidistance)
    const H = (c, r) => (r * w + c) * 2;       // arête horizontale (c,r)-(c+1,r)
    const V = (c, r) => (r * w + c) * 2 + 1;   // arête verticale (c,r)-(c,r+1)

    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const tl = d[r * w + c], tr = d[r * w + c + 1], br = d[(r + 1) * w + c + 1], bl = d[(r + 1) * w + c];
        if (!isValid(tl) || !isValid(tr) || !isValid(br) || !isValid(bl)) continue;
        const mn = Math.min(tl, tr, br, bl), mx = Math.max(tl, tr, br, bl);
        const k0 = lv ? 0 : Math.ceil((mn - eps) / interval), k1 = lv ? lv.length - 1 : Math.floor((mx - eps) / interval);
        for (let k = k0; k <= k1; k++) {
          const L = lv ? lv[k] : k * interval;
          if (!(mn <= L && L < mx)) continue;
          const cs = (tl > L ? 8 : 0) | (tr > L ? 4 : 0) | (br > L ? 2 : 0) | (bl > L ? 1 : 0);
          if (cs === 0 || cs === 15) continue;
          const T = H(c, r), B = H(c, r + 1), Le = V(c, r), R = V(c + 1, r);
          let segs;
          switch (cs) {
            case 1: case 14: segs = [Le, B]; break;
            case 2: case 13: segs = [B, R]; break;
            case 3: case 12: segs = [Le, R]; break;
            case 4: case 11: segs = [T, R]; break;
            case 6: case 9: segs = [T, B]; break;
            case 7: case 8: segs = [Le, T]; break;
            case 5: { const ctr = (tl + tr + br + bl) / 4 > L; segs = ctr ? [Le, T, B, R] : [T, R, Le, B]; break; }
            case 10: { const ctr = (tl + tr + br + bl) / 4 > L; segs = ctr ? [T, R, Le, B] : [Le, T, B, R]; break; }
            default: segs = null;
          }
          if (!segs) continue;
          let arr = buckets.get(k);
          if (!arr) { arr = []; buckets.set(k, arr); }
          for (let s = 0; s < segs.length; s++) arr.push(segs[s]);
        }
      }
    }

    const edgePoint = (e, L) => {
      const vert = e & 1, base = e >> 1;
      const r = Math.floor(base / w), c = base % w;
      const za = d[r * w + c];
      const zb = vert ? d[(r + 1) * w + c] : d[r * w + c + 1];
      const t = (L - za) / (zb - za);
      const xa = g.xmin + (c + 0.5) * g.res, ya = g.ymax - (r + 0.5) * g.res;
      return vert ? [xa, ya - t * g.res] : [xa + t * g.res, ya];
    };

    const lines = [];
    const keys = Array.from(buckets.keys()).sort((a, b) => a - b);
    for (const k of keys) {
      const L = lv ? lv[k] : k * interval;
      const arr = buckets.get(k);
      const nseg = arr.length / 2;
      const byEdge = new Map();
      for (let s = 0; s < nseg; s++) {
        for (let q = 0; q < 2; q++) {
          const e = arr[2 * s + q];
          const l = byEdge.get(e);
          if (l) l.push(s); else byEdge.set(e, [s]);
        }
      }
      const used = new Uint8Array(nseg);
      const nextSeg = (e, cur) => {
        const l = byEdge.get(e);
        if (!l) return -1;
        for (const s of l) if (s !== cur && !used[s]) return s;
        return -1;
      };
      for (let s = 0; s < nseg; s++) {
        if (used[s]) continue;
        used[s] = 1;
        const chain = [arr[2 * s], arr[2 * s + 1]];
        // vers l'avant
        let cur = s, e = chain[1];
        for (;;) {
          const n = nextSeg(e, cur);
          if (n < 0) break;
          used[n] = 1;
          e = arr[2 * n] === e ? arr[2 * n + 1] : arr[2 * n];
          chain.push(e); cur = n;
          if (e === chain[0]) break;
        }
        const closed = chain.length > 3 && chain[chain.length - 1] === chain[0];
        if (!closed) {
          cur = s; e = chain[0];
          const back = [];
          for (;;) {
            const n = nextSeg(e, cur);
            if (n < 0) break;
            used[n] = 1;
            e = arr[2 * n] === e ? arr[2 * n + 1] : arr[2 * n];
            back.push(e); cur = n;
          }
          if (back.length) chain.unshift(...back.reverse());
        }
        let coords = chain.map((ed) => edgePoint(ed, L));
        if (coords.length < 2) continue;
        coords = simplify(coords, tol);
        lines.push({ z: Math.round(L * 1000) / 1000, master: lv ? false : Math.abs(k % master) === 0, closed, coords });
      }
    }
    return lines;
  }


  /* ------------------------------------------------------------------ */
  /* Formats d'export                                                    */
  /* Les gros fichiers sont produits en morceaux (tableaux de chaînes)   */
  /* pour ne jamais construire une chaîne géante qui ferait planter      */
  /* l'onglet ; l'application les assemble ensuite dans un Blob.         */
  /* ------------------------------------------------------------------ */

  const CHUNK = 20000;

  function fmt(v, n) {
    return (Math.round(v * Math.pow(10, n)) / Math.pow(10, n)).toFixed(n);
  }

  /** Regroupe un tableau de lignes en morceaux de CHUNK lignes. */
  function chunkLines(lines, eol) {
    const parts = [];
    for (let i = 0; i < lines.length; i += CHUNK) parts.push(lines.slice(i, i + CHUNK).join(eol) + eol);
    return parts;
  }

  /**
   * Fichier de points topo : « matricule X Y Z », séparés par un espace,
   * sans en-tête ni code, fins de ligne Unix. Ex. : 1 651022.000 6861978.000 120.420
   */
  function toPointsTxt(points) {
    const parts = [];
    let buf = [];
    for (const p of points) {
      buf.push(p.id + ' ' + fmt(p.x, 3) + ' ' + fmt(p.y, 3) + ' ' + fmt(p.z, 3));
      if (buf.length === CHUNK) { parts.push(buf.join('\n') + '\n'); buf = []; }
    }
    if (buf.length) parts.push(buf.join('\n') + '\n');
    return parts;
  }

  function toASC(g) {
    const head = [
      'NCOLS ' + g.w, 'NROWS ' + g.h,
      'XLLCORNER ' + fmt(g.xmin, 3), 'YLLCORNER ' + fmt(g.ymax - g.h * g.res, 3),
      'CELLSIZE ' + g.res, 'NODATA_VALUE ' + NODATA,
    ];
    const parts = [head.join('\n') + '\n'];
    let buf = [];
    for (let r = 0; r < g.h; r++) {
      const row = new Array(g.w);
      for (let c = 0; c < g.w; c++) {
        const z = g.data[r * g.w + c];
        row[c] = isValid(z) ? fmt(z, 2) : String(NODATA);
      }
      buf.push(row.join(' '));
      if (buf.length >= 200) { parts.push(buf.join('\n') + '\n'); buf = []; }
    }
    if (buf.length) parts.push(buf.join('\n') + '\n');
    return parts;
  }

  const PRJ_L93 =
    'PROJCS["RGF93_Lambert_93",GEOGCS["GCS_RGF_1993",DATUM["D_RGF_1993",SPHEROID["GRS_1980",6378137.0,298.257222101]],' +
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],' +
    'PARAMETER["False_Easting",700000.0],PARAMETER["False_Northing",6600000.0],PARAMETER["Central_Meridian",3.0],' +
    'PARAMETER["Standard_Parallel_1",49.0],PARAMETER["Standard_Parallel_2",44.0],PARAMETER["Latitude_Of_Origin",46.5],' +
    'UNIT["Meter",1.0]]';

  function escXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * LandXML 1.2 : surface TIN « TN » + points de calcul. Ordre LandXML : Nord Est Z.
   * faces : Int32Array plat (voir gridTIN). Retourne un tableau de morceaux.
   */
  function toLandXML(points, faces, opts) {
    opts = opts || {};
    const now = new Date();
    const date = now.toISOString().slice(0, 10), time = now.toISOString().slice(11, 19);
    const name = escXml(opts.name || 'TN');
    const head = [];
    head.push('<?xml version="1.0" encoding="UTF-8"?>');
    head.push('<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="' + date + '" time="' + time + '">');
    head.push('  <Units><Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="milliBars" angularUnit="decimal degrees" directionUnit="decimal degrees"/></Units>');
    head.push('  <CoordinateSystem name="RGF93 v1 / Lambert-93" epsgCode="2154" verticalDatum="NGF-IGN69"/>');
    head.push('  <Application name="ExporTopo" manufacturer="ExporTopo (open source)" version="' + VERSION + '"/>');
    const parts = [head.join('\n') + '\n'];
    if (opts.cgPoints !== false) {
      parts.push('  <CgPoints name="' + name + '">\n');
      parts.push(...chunkLines(points.map((p) => '    <CgPoint name="' + p.id + '" code="TN">' + fmt(p.y, 3) + ' ' + fmt(p.x, 3) + ' ' + fmt(p.z, 3) + '</CgPoint>'), '\n'));
      parts.push('  </CgPoints>\n');
    }
    parts.push('  <Surfaces>\n    <Surface name="' + name + '" desc="' + escXml(opts.desc || 'Terrain naturel - MNT LiDAR HD IGN') + '">\n      <Definition surfType="TIN">\n        <Pnts>\n');
    parts.push(...chunkLines(points.map((p, k) => '          <P id="' + (k + 1) + '">' + fmt(p.y, 3) + ' ' + fmt(p.x, 3) + ' ' + fmt(p.z, 3) + '</P>'), '\n'));
    parts.push('        </Pnts>\n        <Faces>\n');
    let buf = [];
    for (let i = 0; i < faces.length; i += 3) {
      buf.push('          <F>' + (faces[i] + 1) + ' ' + (faces[i + 1] + 1) + ' ' + (faces[i + 2] + 1) + '</F>');
      if (buf.length === CHUNK) { parts.push(buf.join('\n') + '\n'); buf = []; }
    }
    if (buf.length) parts.push(buf.join('\n') + '\n');
    parts.push('        </Faces>\n      </Definition>\n    </Surface>\n  </Surfaces>\n</LandXML>\n');
    return parts;
  }

  /* ---------------- DXF R12 (AC1009), lisible par tous les logiciels CAO ---------------- */

  function DxfWriter() {
    this.layers = new Map();
    this.ltypes = new Map([['CONTINUOUS', null]]);
    this.blocks = [];
    this.ents = [];
    this.ext = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    this.pdsize = 0.1;
  }

  /** Calque : couleur AutoCAD (1-255) et type de trait (CONTINUOUS, TIRETS, POINTILLES, AXE). */
  DxfWriter.prototype.layer = function (name, color, ltype) {
    if (!this.layers.has(name)) this.layers.set(name, { color: color || 7, ltype: ltype || 'CONTINUOUS' });
    if (ltype && ltype !== 'CONTINUOUS') this._ltype(ltype);
    return this;
  };

  const LTYPE_DEFS = {
    TIRETS: ['Tirets __ __ __', [1.0, -0.5]],
    POINTILLES: ['Pointillés . . .', [0.0, -0.3]],
    AXE: ['Axe ____ _ ____', [2.0, -0.4, 0.4, -0.4]],
  };
  DxfWriter.prototype._ltype = function (name) {
    if (!this.ltypes.has(name) && LTYPE_DEFS[name]) this.ltypes.set(name, LTYPE_DEFS[name]);
  };

  /** Bloc réutilisable (symbole). entities : chaînes DXF déjà formées, sur le calque 0 pour hériter du calque d'insertion. */
  DxfWriter.prototype.block = function (name, entities) {
    this.blocks.push('0\nBLOCK\n8\n0\n2\n' + name + '\n70\n0\n10\n0.0\n20\n0.0\n30\n0.0\n3\n' + name + '\n' +
      entities.join('\n') + '\n0\nENDBLK\n8\n0');
  };

  DxfWriter.prototype.insert = function (name, x, y, z, scale, layer, rot) {
    this._grow(x, y, z);
    let e = '0\nINSERT\n8\n' + this._L(layer) + '\n2\n' + name + '\n10\n' + fmt(x, 3) + '\n20\n' + fmt(y, 3) + '\n30\n' + fmt(z, 3) +
      '\n41\n' + fmt(scale, 4) + '\n42\n' + fmt(scale, 4) + '\n43\n' + fmt(scale, 4);
    if (rot) e += '\n50\n' + fmt(rot, 3);
    this.ents.push(e);
  };

  DxfWriter.prototype.line = function (a, b, layer) {
    const za = a[2] || 0, zb = b[2] || 0;
    this._grow(a[0], a[1], za); this._grow(b[0], b[1], zb);
    this.ents.push('0\nLINE\n8\n' + this._L(layer) + '\n10\n' + fmt(a[0], 3) + '\n20\n' + fmt(a[1], 3) + '\n30\n' + fmt(za, 3) +
      '\n11\n' + fmt(b[0], 3) + '\n21\n' + fmt(b[1], 3) + '\n31\n' + fmt(zb, 3));
  };

  DxfWriter.prototype.circle = function (x, y, z, r, layer) {
    this._grow(x - r, y - r, z); this._grow(x + r, y + r, z);
    this.ents.push('0\nCIRCLE\n8\n' + this._L(layer) + '\n10\n' + fmt(x, 3) + '\n20\n' + fmt(y, 3) + '\n30\n' + fmt(z, 3) + '\n40\n' + fmt(r, 3));
  };

  DxfWriter.prototype._grow = function (x, y, z) {
    const e = this.ext;
    if (x < e[0]) e[0] = x; if (y < e[1]) e[1] = y; if (z < e[2]) e[2] = z;
    if (x > e[3]) e[3] = x; if (y > e[4]) e[4] = y; if (z > e[5]) e[5] = z;
  };

  DxfWriter.prototype._L = function (l) { this.layer(l); return l; };

  DxfWriter.prototype.point = function (x, y, z, layer) {
    this._grow(x, y, z);
    this.ents.push('0\nPOINT\n8\n' + this._L(layer) + '\n10\n' + fmt(x, 3) + '\n20\n' + fmt(y, 3) + '\n30\n' + fmt(z, 3));
  };

  /** Texte. align : 'left' (défaut) | 'center' (centré sur le point). width : facteur de largeur (1 par défaut). */
  DxfWriter.prototype.text = function (x, y, z, height, str, layer, rot, align, width) {
    this._grow(x, y, z);
    const s = String(str).replace(/[\r\n]+/g, ' ');
    let e = '0\nTEXT\n8\n' + this._L(layer) + '\n10\n' + fmt(x, 3) + '\n20\n' + fmt(y, 3) + '\n30\n' + fmt(z, 3) +
      '\n40\n' + fmt(height, 3) + '\n1\n' + s;
    if (rot) e += '\n50\n' + fmt(rot, 3);
    if (width && width !== 1) e += '\n41\n' + fmt(width, 3);
    if (align === 'center') e += '\n72\n1\n73\n2\n11\n' + fmt(x, 3) + '\n21\n' + fmt(y, 3) + '\n31\n' + fmt(z, 3);
    this.ents.push(e);
  };

  /** Polyligne 2D (avec élévation constante). */
  DxfWriter.prototype.poly2d = function (coords, closed, layer, elev) {
    if (coords.length < 2) return;
    const L = this._L(layer);
    elev = elev || 0;
    const parts = ['0\nPOLYLINE\n8\n' + L + '\n66\n1\n10\n0.0\n20\n0.0\n30\n' + fmt(elev, 3) + '\n70\n' + (closed ? 1 : 0)];
    for (const p of coords) {
      this._grow(p[0], p[1], elev);
      parts.push('0\nVERTEX\n8\n' + L + '\n10\n' + fmt(p[0], 3) + '\n20\n' + fmt(p[1], 3) + '\n30\n' + fmt(elev, 3));
    }
    parts.push('0\nSEQEND\n8\n' + L);
    this.ents.push(parts.join('\n'));
  };

  /** Polyligne 3D. */
  DxfWriter.prototype.poly3d = function (coords, closed, layer) {
    if (coords.length < 2) return;
    const L = this._L(layer);
    const parts = ['0\nPOLYLINE\n8\n' + L + '\n66\n1\n10\n0.0\n20\n0.0\n30\n0.0\n70\n' + (closed ? 9 : 8)];
    for (const p of coords) {
      const z = p[2] || 0;
      this._grow(p[0], p[1], z);
      parts.push('0\nVERTEX\n8\n' + L + '\n10\n' + fmt(p[0], 3) + '\n20\n' + fmt(p[1], 3) + '\n30\n' + fmt(z, 3) + '\n70\n32');
    }
    parts.push('0\nSEQEND\n8\n' + L);
    this.ents.push(parts.join('\n'));
  };

  DxfWriter.prototype.face3d = function (a, b, c, layer) {
    const L = this._L(layer);
    let e = '0\n3DFACE\n8\n' + L;
    const pts = [a, b, c, c];
    for (let k = 0; k < 4; k++) {
      e += '\n1' + k + '\n' + fmt(pts[k][0], 3) + '\n2' + k + '\n' + fmt(pts[k][1], 3) + '\n3' + k + '\n' + fmt(pts[k][2], 3);
    }
    this.ents.push(e);
  };

  /** Le DXF complet, en morceaux de chaînes (voir CHUNK). */
  DxfWriter.prototype.toParts = function () {
    const e = this.ext;
    const ext = isFinite(e[0]) ? e : [0, 0, 0, 0, 0, 0];
    const out = [];
    out.push('0\nSECTION\n2\nHEADER');
    out.push('9\n$ACADVER\n1\nAC1009');
    out.push('9\n$DWGCODEPAGE\n3\nANSI_1252');
    out.push('9\n$INSBASE\n10\n0.0\n20\n0.0\n30\n0.0');
    out.push('9\n$EXTMIN\n10\n' + fmt(ext[0], 3) + '\n20\n' + fmt(ext[1], 3) + '\n30\n' + fmt(ext[2], 3));
    out.push('9\n$EXTMAX\n10\n' + fmt(ext[3], 3) + '\n20\n' + fmt(ext[4], 3) + '\n30\n' + fmt(ext[5], 3));
    out.push('9\n$PDMODE\n70\n3');
    out.push('9\n$PDSIZE\n40\n' + fmt(this.pdsize, 3));
    out.push('9\n$LTSCALE\n40\n' + fmt(this.ltscale || 1, 3));
    out.push('0\nENDSEC');
    out.push('0\nSECTION\n2\nTABLES');
    out.push('0\nTABLE\n2\nLTYPE\n70\n' + this.ltypes.size);
    out.push('0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0');
    for (const [name, def] of this.ltypes) {
      if (!def) continue;
      const pat = def[1], tot = pat.reduce((a, v) => a + Math.abs(v), 0);
      out.push('0\nLTYPE\n2\n' + name + '\n70\n0\n3\n' + def[0] + '\n72\n65\n73\n' + pat.length + '\n40\n' + fmt(tot, 3) + pat.map((v) => '\n49\n' + fmt(v, 3)).join(''));
    }
    out.push('0\nENDTAB');
    out.push('0\nTABLE\n2\nLAYER\n70\n' + (this.layers.size + 1));
    out.push('0\nLAYER\n2\n0\n70\n0\n62\n7\n6\nCONTINUOUS');
    for (const [name, l] of this.layers) out.push('0\nLAYER\n2\n' + name + '\n70\n0\n62\n' + l.color + '\n6\n' + l.ltype);
    out.push('0\nENDTAB');
    out.push('0\nTABLE\n2\nSTYLE\n70\n1\n0\nSTYLE\n2\nSTANDARD\n70\n0\n40\n0.0\n41\n1.0\n50\n0.0\n71\n0\n42\n2.5\n3\ntxt\n4\n\n0\nENDTAB');
    out.push('0\nENDSEC');
    out.push('0\nSECTION\n2\nBLOCKS' + (this.blocks.length ? '\n' + this.blocks.join('\n') : '') + '\n0\nENDSEC');
    out.push('0\nSECTION\n2\nENTITIES');
    const parts = [out.join('\n') + '\n'];
    for (let i = 0; i < this.ents.length; i += CHUNK) parts.push(this.ents.slice(i, i + CHUNK).join('\n') + '\n');
    parts.push('0\nENDSEC\n0\nEOF\n');
    return parts;
  };

  DxfWriter.prototype.toString = function () { return this.toParts().join(''); };

  /** Encodage Windows-1252 pour le DXF R12 (accents des noms de communes, de voies…). */
  const CP1252_EXTRA = { 0x20ac: 0x80, 0x2019: 0x92, 0x2018: 0x91, 0x201c: 0x93, 0x201d: 0x94, 0x2013: 0x96, 0x2014: 0x97, 0x0153: 0x9c, 0x0152: 0x8c, 0x2026: 0x85 };
  function encodeCP1252(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      out[i] = c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : CP1252_EXTRA[c] || 0x3f;
    }
    return out;
  }

  /* ---------------- Assemblage du DXF « TN » complet ---------------- */

  const LAYERS = {
    EMPRISE: ['TL_EMPRISE', 140],
    POINTS: ['TN_POINTS', 7],
    ALTI: ['TN_ALTITUDES', 3],
    MATRICULES: ['TN_MATRICULES', 8],
    COURBES: ['TN_COURBES', 34],
    COURBES_M: ['TN_COURBES_MAITRESSES', 30],
    COURBES_TXT: ['TN_COURBES_TEXTE', 30],
    MNT: ['TN_MNT_3DFACE', 253],
    PARCELLES: ['CAD_PARCELLES', 1],
    PROJET: ['CAD_PARCELLES_PROJET', 140],
    NUMEROS: ['CAD_NUMEROS', 1],
    CAD_BATI: ['CAD_BATIMENTS', 8],
    BORNES: ['CAD_BORNES', 1],
    BATI: ['BDT_BATIMENTS', 9],
    ROUTES: ['BDT_VOIRIE_AXES', 2],
    ROUTES_TXT: ['BDT_VOIRIE_NOMS', 2],
    FER: ['BDT_VOIES_FERREES', 251],
    HYDRO: ['BDT_HYDRO_AXES', 5],
    HYDRO_S: ['BDT_HYDRO_SURFACES', 4],
    VEGE: ['BDT_VEGETATION', 3],
  };

  function eachPart(geom, fn) {
    if (!geom) return;
    const t = geom.type, c = geom.coordinates;
    if (t === 'Polygon') c.forEach((ring) => fn(ring, true));
    else if (t === 'MultiPolygon') c.forEach((poly) => poly.forEach((ring) => fn(ring, true)));
    else if (t === 'LineString') fn(c, false);
    else if (t === 'MultiLineString') c.forEach((l) => fn(l, false));
    else if (t === 'Point') fn([c], false);
    else if (t === 'MultiPoint') c.forEach((p) => fn([p], false));
    else if (t === 'GeometryCollection') geom.geometries.forEach((gg) => eachPart(gg, fn));
  }

  function stripClosing(ring) {
    const n = ring.length;
    if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) return ring.slice(0, n - 1);
    return ring;
  }

  function has3D(coords) {
    for (const p of coords) if (p.length < 3 || !isValid(p[2])) return false;
    return true;
  }

  function addFeatures(dxf, features, layer, opts) {
    opts = opts || {};
    for (const f of features) {
      eachPart(f.geometry, (coords, closed) => {
        if (coords.length === 1) { const p = coords[0]; dxf.point(p[0], p[1], has3D(coords) ? p[2] : 0, layer); return; }
        const cc = closed ? stripClosing(coords) : coords;
        if (opts.use3D && has3D(cc)) dxf.poly3d(cc, closed, layer);
        else dxf.poly2d(cc, closed, layer, 0);
      });
    }
  }

  /**
   * Tailles des repères de points selon le pas du semis.
   * - texte d'altitude : ~20 % du pas, plafonné à la hauteur liée à l'échelle du plan ;
   * - croix : ~15 % du pas ;
   * - décalage du texte : proportionnel au pas, pour rester lisible sans toucher le point suivant.
   */
  function pointMarks(step, scaleHeight) {
    const th = Math.min(scaleHeight, 0.2 * step);
    return { textHeight: th, cross: 0.15 * step, dx: 0.1 * step, dy: 0.06 * step, width: 0.8 };
  }

  /**
   * Construit le DXF complet. Retourne un tableau de morceaux de texte.
   * data = { ring, points, step, contours, faces (Int32Array), vectors: { parcelles, projet, cadBati, bornes, bati, routes, fer, hydro, hydroS, vege } }
   * opts = { textHeight (hauteur liée à l'échelle), altText, matText, faces3d, decimals }
   */
  function buildDXF(data, opts) {
    const dxf = new DxfWriter();
    const th = opts.textHeight || 0.4;
    const dec = opts.decimals === undefined ? 2 : opts.decimals;
    for (const k in LAYERS) dxf.layer(LAYERS[k][0], LAYERS[k][1]);
    const Lr = (k) => LAYERS[k][0];

    if (data.ring) dxf.poly2d(data.ring, true, Lr('EMPRISE'), 0);

    // Couches de contexte en premier : les points TN restent au-dessus à l'affichage.
    const v = data.vectors || {};
    if (v.vege) addFeatures(dxf, v.vege, Lr('VEGE'));
    if (v.hydroS) addFeatures(dxf, v.hydroS, Lr('HYDRO_S'));
    if (v.hydro) addFeatures(dxf, v.hydro, Lr('HYDRO'), { use3D: true });
    if (v.fer) addFeatures(dxf, v.fer, Lr('FER'), { use3D: true });
    if (v.routes) {
      addFeatures(dxf, v.routes, Lr('ROUTES'), { use3D: true });
      const seen = new Set();
      for (const f of v.routes) {
        const nom = f.properties && (f.properties.nom_voie_ban_gauche || f.properties.nom_1_gauche || f.properties.cpx_toponyme_route_nommee || f.properties.nom_collaboratif_gauche);
        if (!nom || !f.geometry) continue;
        const line = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates[0] : f.geometry.coordinates;
        if (!line || line.length < 2) continue;
        const key = nom + '|' + Math.round(line[0][0] / 50) + '|' + Math.round(line[0][1] / 50);
        if (seen.has(key)) continue;
        seen.add(key);
        const m = Math.floor(line.length / 2);
        const a = line[Math.max(0, m - 1)], b = line[Math.min(line.length - 1, m)];
        let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
        if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
        dxf.text((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0, th, nom, Lr('ROUTES_TXT'), ang, 'center');
      }
    }
    if (v.bati) addFeatures(dxf, v.bati, Lr('BATI'));
    if (v.cadBati) addFeatures(dxf, v.cadBati, Lr('CAD_BATI'));
    if (v.parcelles) {
      addFeatures(dxf, v.parcelles, Lr('PARCELLES'));
      for (const f of v.parcelles) {
        const p = f.properties || {};
        const label = p.section && p.numero ? (String(p.section).replace(/^0+/, '') + ' ' + String(p.numero).replace(/^0+/, '')) : p.idu || '';
        if (!label || !f.geometry) continue;
        const ring = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0];
        if (!ring) continue;
        const lp = labelPoint(stripClosing(ring));
        dxf.text(lp[0], lp[1], 0, th * 1.5, label, Lr('NUMEROS'), 0, 'center');
      }
    }
    if (v.projet) addFeatures(dxf, v.projet, Lr('PROJET'));
    if (v.bornes) addFeatures(dxf, v.bornes, Lr('BORNES'));

    if (data.contours) {
      for (const c of data.contours) {
        const layer = c.master ? Lr('COURBES_M') : Lr('COURBES');
        dxf.poly3d(c.coords.map((p) => [p[0], p[1], c.z]), c.closed, layer);
        if (c.master && c.coords.length > 4) {
          const m = Math.floor(c.coords.length / 2);
          const a = c.coords[m - 1], b = c.coords[m];
          let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
          if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
          dxf.text((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, c.z, th, fmt(c.z, c.z % 1 ? 2 : 0), Lr('COURBES_TXT'), ang, 'center');
        }
      }
    }

    if (data.faces && opts.faces3d) {
      const P = data.points, F = data.faces;
      for (let i = 0; i < F.length; i += 3) {
        const a = P[F[i]], b = P[F[i + 1]], c = P[F[i + 2]];
        dxf.face3d([a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z], Lr('MNT'));
      }
    }

    if (opts.extra) opts.extra(dxf, th);

    if (data.points && opts.writePoints !== false) {
      const mk = pointMarks(data.step || 1, th);
      dxf.pdsize = mk.cross;
      for (const p of data.points) {
        dxf.point(p.x, p.y, p.z, Lr('POINTS'));
        if (opts.altText !== false) dxf.text(p.x + mk.dx, p.y + mk.dy, p.z, mk.textHeight, fmt(p.z, dec), Lr('ALTI'), 0, 'left', mk.width);
        if (opts.matText) dxf.text(p.x + mk.dx, p.y - mk.dy - mk.textHeight * 0.7, p.z, mk.textHeight * 0.7, String(p.id), Lr('MATRICULES'), 0, 'left', mk.width);
      }
    }
    return dxf.toParts();
  }

  /** GeoJSON en Lambert-93. Retourne un tableau de morceaux. */
  function toGeoJSON(features, name) {
    const head = '{"type":"FeatureCollection","name":' + JSON.stringify(name || 'export') +
      ',"crs":{"type":"name","properties":{"name":"urn:ogc:def:crs:EPSG::2154"}},"features":[\n';
    const parts = [head];
    let buf = [];
    for (let i = 0; i < features.length; i++) {
      buf.push(JSON.stringify(features[i]));
      if (buf.length === CHUNK) { parts.push(buf.join(',\n') + (i < features.length - 1 ? ',\n' : '\n')); buf = []; }
    }
    if (buf.length) parts.push(buf.join(',\n') + '\n');
    parts.push(']}\n');
    return parts;
  }

  function contoursToFeatures(lines) {
    return lines.map((c) => ({
      type: 'Feature',
      properties: { altitude: c.z, type: c.master ? 'maitresse' : 'normale' },
      geometry: { type: 'LineString', coordinates: c.coords.map((p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000, c.z]) },
    }));
  }

  function pointsToFeatures(points) {
    return points.map((p) => ({
      type: 'Feature',
      properties: { matricule: p.id, z: Math.round(p.z * 1000) / 1000 },
      geometry: { type: 'Point', coordinates: [p.x, p.y, Math.round(p.z * 1000) / 1000] },
    }));
  }

  /** Fichier de géoréférencement (world file) d'une image en Lambert-93. */
  function worldFile(xmin, ymax, resX, resY) {
    return [fmt(resX, 6), '0.000000', '0.000000', fmt(-resY, 6), fmt(xmin + resX / 2, 4), fmt(ymax - resY / 2, 4)].join('\r\n') + '\r\n';
  }

  return {
    VERSION, NODATA, isValid, pointInRing, inZone, ringArea, ringBBox, ringCentroid, labelPoint, simplify,
    makeGrid, gridStats, fillGaps, sample, smoothGrid, downsample, maskGrid,
    samplePoints, gridTIN, contours,
    toPointsTxt, toASC, toLandXML, PRJ_L93, DxfWriter, buildDXF, pointMarks, encodeCP1252, LAYERS,
    toGeoJSON, contoursToFeatures, pointsToFeatures, worldFile, fmt, eachPart, stripClosing,
  };
});
