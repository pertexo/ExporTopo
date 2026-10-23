/*!
 * ExporTopo — interface : carte, tracé et édition de la zone, appels aux services IGN,
 * prévisualisation puis export ZIP.
 * Licence MIT.
 */
(function () {
  'use strict';
  const T = window.TopoCore;

  /* ------------------------------------------------------------------ */
  /* Services publics IGN (Géoplateforme)                                */
  /* ------------------------------------------------------------------ */
  const GPF = 'https://data.geopf.fr';
  const WMSR = GPF + '/wms-r/wms';
  const WFS = GPF + '/wfs/ows';
  const SRC = {
    mntLidar: 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93',
    mntRge: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES',
    ortho: 'HR.ORTHOIMAGERY.ORTHOPHOTOS',
    orthoFallback: 'ORTHOIMAGERY.ORTHOPHOTOS',
    parcelle: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle',
    cadBati: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS:batiment',
    borne: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS:borne_limite_propriete',
    bati: 'BDTOPO_V3:batiment',
    route: 'BDTOPO_V3:troncon_de_route',
    hydro: 'BDTOPO_V3:troncon_hydrographique',
    hydroS: 'BDTOPO_V3:surface_hydrographique',
    fer: 'BDTOPO_V3:troncon_de_voie_ferree',
    vege: 'BDTOPO_V3:zone_de_vegetation',
    lidarMeta: 'IGNF_LIDAR-HD_METADONNEE:metadata',
    orthoMeta: 'ORTHOIMAGERY.ORTHOPHOTOS.GRAPHE-MOSAIQUAGE:graphe_bdortho',
  };
  const MAX_TILE = 2000;           // pixels par requête WMS
  const MAX_AREA = 4e6;            // 4 km² d'emprise maximum
  const MAX_POINTS = 400000;

  proj4.defs('EPSG:2154', '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');
  const toL93 = (ll) => proj4('EPSG:4326', 'EPSG:2154', [ll.lng, ll.lat]);
  const toWGS = (xy) => { const p = proj4('EPSG:2154', 'EPSG:4326', [xy[0], xy[1]]); return L.latLng(p[1], p[0]); };

  const $ = (id) => document.getElementById(id);
  const fr = (v, d) => Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });

  /* ------------------------------------------------------------------ */
  /* Carte                                                               */
  /* ------------------------------------------------------------------ */
  const wmts = (layer, style, format, maxNative, extra) =>
    L.tileLayer(GPF + '/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=' + layer + '&STYLE=' + encodeURIComponent(style) +
      '&TILEMATRIXSET=PM&FORMAT=' + format + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
      Object.assign({ maxZoom: 21, maxNativeZoom: maxNative, attribution: '&copy; <a href="https://www.ign.fr" target="_blank" rel="noopener">IGN</a>' }, extra || {}));

  const baseLayers = {
    'Plan IGN': wmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'normal', 'image/png', 19),
    'Photographies aériennes': wmts('ORTHOIMAGERY.ORTHOPHOTOS', 'normal', 'image/jpeg', 19),
  };
  const overlays = {
    'Cadastre': wmts('CADASTRALPARCELS.PARCELLAIRE_EXPRESS', 'PCI vecteur', 'image/png', 19, { opacity: 0.9 }),
    'Relief LiDAR HD (ombrage)': wmts('IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW', 'normal', 'image/png', 18, { opacity: 0.55 }),
  };

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('exportopo.view') || 'null'); } catch (e) { saved = null; }
  const map = L.map('map', { zoomControl: true }).setView(saved ? [saved.lat, saved.lng] : [46.6, 2.4], saved ? saved.z : 6);
  baseLayers['Photographies aériennes'].addTo(map);
  overlays['Cadastre'].addTo(map);
  L.control.layers(baseLayers, overlays, { collapsed: true }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  map.on('moveend', () => {
    try { const c = map.getCenter(); localStorage.setItem('exportopo.view', JSON.stringify({ lat: c.lat, lng: c.lng, z: map.getZoom() })); } catch (e) { /* stockage indisponible */ }
  });

  const cssVar = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
  const zoneStyle = () => ({ color: cssVar('--zone', '#00B4FF'), weight: 3, fillOpacity: 0.10, dashArray: '8 5' });

  /* ------------------------------------------------------------------ */
  /* État                                                                */
  /* ------------------------------------------------------------------ */
  const state = {
    mode: null,
    ring: null,          // anneau Lambert-93 [[x,y],...] sans point de fermeture
    kind: null,
    zoneLayer: null,
    gripLayer: L.layerGroup().addTo(map),
    parcels: new Map(),  // idu -> feature L93
    parcelLayer: L.layerGroup().addTo(map),
    commune: null,
    busy: false,
    midMode: 'stretch',  // poignée du milieu : 'stretch' (étirer le côté) | 'add' (ajouter un sommet)
    ctrl: false, shift: false,
    ds: null,            // dernier jeu de données préparé
  };
  document.addEventListener('keydown', (e) => { state.ctrl = e.ctrlKey || e.metaKey; state.shift = e.shiftKey; });
  document.addEventListener('keyup', (e) => { state.ctrl = e.ctrlKey || e.metaKey; state.shift = e.shiftKey; });

  /* ------------------------------------------------------------------ */
  /* Tracé de la zone                                                    */
  /* ------------------------------------------------------------------ */
  const draw = { verts: [], markers: [], line: null, rubber: null, rect: null, cursor: null, raf: 0, hot: false };

  function tip(txt) { const t = $('mapTip'); t.hidden = !txt; t.textContent = txt || ''; }

  const vertexIcon = (cls) => L.divIcon({ className: 'dv ' + (cls || ''), iconSize: [12, 12], iconAnchor: [6, 6] });
  const firstIcon = (ready, hot) => L.divIcon({
    className: 'dv-first' + (ready ? ' ready' : '') + (hot ? ' hot' : ''),
    html: '<span></span>', iconSize: [26, 26], iconAnchor: [13, 13],
  });

  function setMode(mode) {
    const next = state.mode === mode ? null : mode;
    cancelDraw();
    state.mode = next;
    ['toolRect', 'toolPoly', 'toolParcel'].forEach((id) => $(id).setAttribute('aria-pressed', 'false'));
    map.getContainer().classList.toggle('drawing', next === 'rect' || next === 'poly');
    if (next === 'rect' || next === 'poly') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
    $('drawBar').hidden = !(next === 'rect' || next === 'poly');
    $('dbUndo').hidden = next !== 'poly';
    $('dbFinish').hidden = next !== 'poly';
    if (next === 'rect') { $('toolRect').setAttribute('aria-pressed', 'true'); tip('Cliquez un premier coin, puis le coin opposé.'); }
    else if (next === 'poly') { $('toolPoly').setAttribute('aria-pressed', 'true'); tip('Cliquez le premier sommet.'); }
    else if (next === 'parcel') {
      $('toolParcel').setAttribute('aria-pressed', 'true');
      tip(map.getZoom() < 16 ? 'Zoomez sur le secteur, puis cliquez les parcelles à inclure.' : 'Cliquez les parcelles à inclure (re-cliquez pour retirer).');
    } else tip('');
    renderGrips();
    updateDrawBar();
  }

  function cancelDraw() {
    for (const m of draw.markers) map.removeLayer(m);
    ['line', 'rubber', 'rect'].forEach((k) => { if (draw[k]) { map.removeLayer(draw[k]); draw[k] = null; } });
    draw.verts = []; draw.markers = []; draw.cursor = null; draw.hot = false;
  }

  function startLayers() {
    const st = zoneStyle();
    if (!draw.line) draw.line = L.polyline([], { color: st.color, weight: 2.5, interactive: false }).addTo(map);
    if (!draw.rubber) draw.rubber = L.polyline([], { color: st.color, weight: 1.5, dashArray: '4 5', opacity: 0.9, interactive: false }).addTo(map);
  }

  function addVertex(ll) {
    startLayers();
    draw.verts.push(ll);
    const first = draw.verts.length === 1;
    const m = L.marker(ll, { icon: first ? firstIcon(false, false) : vertexIcon(), keyboard: false, zIndexOffset: first ? 1000 : 0 }).addTo(map);
    if (first) {
      m.on('click', (e) => { L.DomEvent.stop(e); if (draw.verts.length >= 3) finishPoly(); });
      m.bindTooltip('Cliquer ici pour fermer', { direction: 'top', offset: [0, -14], className: 'close-tip' });
    }
    draw.markers.push(m);
    draw.line.setLatLngs(draw.verts);
    refreshFirst();
    updateDrawBar();
    scheduleRubber();
  }

  function refreshFirst() {
    const m = draw.markers[0];
    if (!m) return;
    const ready = draw.verts.length >= 3;
    m.setIcon(firstIcon(ready, ready && draw.hot));
    if (ready) m.openTooltip(); else m.closeTooltip();
  }

  function undoVertex() {
    if (!draw.verts.length) return;
    draw.verts.pop();
    const m = draw.markers.pop();
    map.removeLayer(m);
    if (draw.line) draw.line.setLatLngs(draw.verts);
    draw.hot = false;
    refreshFirst();
    updateDrawBar();
    scheduleRubber();
  }

  function scheduleRubber() {
    if (draw.raf) return;
    draw.raf = requestAnimationFrame(() => { draw.raf = 0; updateRubber(); });
  }

  function updateRubber() {
    const cur = draw.cursor;
    if (state.mode === 'poly') {
      if (!draw.rubber) return;
      const n = draw.verts.length;
      if (!n || !cur) { draw.rubber.setLatLngs([]); tipPoly(); return; }
      // Aimantation sur le premier sommet
      let hot = false;
      if (n >= 3) {
        const p0 = map.latLngToContainerPoint(draw.verts[0]), p = map.latLngToContainerPoint(cur);
        hot = p0.distanceTo(p) < 16;
      }
      if (hot !== draw.hot) { draw.hot = hot; refreshFirst(); }
      const end = hot ? draw.verts[0] : cur;
      draw.rubber.setLatLngs(n >= 2 ? [draw.verts[n - 1], end, draw.verts[0]] : [draw.verts[0], end]);
      tipPoly(end);
    } else if (state.mode === 'rect') {
      if (draw.verts.length !== 1 || !cur) return;
      const b = L.latLngBounds(draw.verts[0], cur);
      if (!draw.rect) draw.rect = L.rectangle(b, Object.assign(zoneStyle(), { interactive: false })).addTo(map);
      else draw.rect.setBounds(b);
      const a = toL93(draw.verts[0]), c = toL93(cur);
      tip(fr(Math.abs(c[0] - a[0]), 1) + ' × ' + fr(Math.abs(c[1] - a[1]), 1) + ' m · ' + areaTxt(Math.abs((c[0] - a[0]) * (c[1] - a[1]))) + ' — cliquez le coin opposé.');
    }
  }

  function tipPoly(cursor) {
    const n = draw.verts.length;
    if (!n) { tip('Cliquez le premier sommet.'); return; }
    if (draw.hot) { tip('Cliquez pour fermer le polygone.'); return; }
    const pts = draw.verts.concat(cursor ? [cursor] : []).map(toL93);
    let seg = '';
    if (cursor) {
      const a = toL93(draw.verts[n - 1]), b = toL93(cursor);
      seg = 'côté ' + fr(Math.hypot(b[0] - a[0], b[1] - a[1]), 1) + ' m · ';
    }
    const area = pts.length >= 3 ? areaTxt(T.ringArea(pts)) + ' · ' : '';
    tip(n + ' sommet' + (n > 1 ? 's' : '') + ' · ' + seg + area + (n >= 3 ? 'cliquez le point rouge pour fermer.' : 'continuez.'));
  }

  function areaTxt(a) { return a >= 10000 ? fr(a / 10000, 2) + ' ha' : fr(a) + ' m²'; }

  function updateDrawBar() {
    $('dbUndo').disabled = !draw.verts.length;
    $('dbFinish').disabled = draw.verts.length < 3;
  }

  map.on('click', (e) => {
    if (state.busy) return;
    if (state.mode === 'rect') {
      if (!draw.verts.length) {
        draw.verts.push(e.latlng);
        draw.markers.push(L.marker(e.latlng, { icon: vertexIcon(), keyboard: false, interactive: false }).addTo(map));
        tip('Cliquez le coin opposé.');
      } else {
        const a = toL93(draw.verts[0]), b = toL93(e.latlng);
        if (Math.abs(a[0] - b[0]) < 1 || Math.abs(a[1] - b[1]) < 1) { tip('Rectangle trop petit : cliquez plus loin.'); return; }
        const ring = [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.min(a[1], b[1])],
          [Math.max(a[0], b[0]), Math.max(a[1], b[1])], [Math.min(a[0], b[0]), Math.max(a[1], b[1])]];
        setMode(null);
        setZone(ring, 'rectangle');
      }
    } else if (state.mode === 'poly') {
      if (draw.hot && draw.verts.length >= 3) { finishPoly(); return; }
      addVertex(e.latlng);
    } else if (state.mode === 'parcel') {
      pickParcel(e.latlng);
    }
  });
  map.on('mousemove', (e) => {
    if (state.mode !== 'rect' && state.mode !== 'poly') return;
    draw.cursor = e.latlng;
    scheduleRubber();
  });
  map.on('mouseout', () => { if (state.mode === 'poly') { draw.cursor = null; scheduleRubber(); } });
  map.on('dblclick', (e) => { if (state.mode === 'poly') { L.DomEvent.stop(e); finishPoly(); } });
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || '');
    if (typing || !$('preview').hidden) return;
    if (e.key === 'Escape' && state.mode) setMode(null);
    if (state.mode === 'poly' && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); undoVertex(); }
    if (state.mode === 'poly' && e.key === 'Enter') finishPoly();
  });

  function finishPoly() {
    // Un double-clic ajoute deux sommets quasi identiques : on les dédoublonne.
    const pts = [];
    for (const ll of draw.verts) {
      const xy = toL93(ll);
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(xy[0] - last[0], xy[1] - last[1]) > 0.05) pts.push(xy);
    }
    if (pts.length > 3) {
      const a = pts[0], b = pts[pts.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05) pts.pop();
    }
    if (pts.length < 3) { tip('Il faut au moins trois sommets.'); return; }
    setMode(null);
    setZone(pts, 'polygone');
  }

  $('toolRect').onclick = () => setMode('rect');
  $('toolPoly').onclick = () => setMode('poly');
  $('toolParcel').onclick = () => { if (state.mode !== 'parcel' && state.parcels.size === 0 && state.kind === 'parcelles') clearZone(); setMode('parcel'); };
  $('clearZone').onclick = () => clearZone();
  $('dbUndo').onclick = () => undoVertex();
  $('dbFinish').onclick = () => finishPoly();
  $('dbCancel').onclick = () => setMode(null);
  ['midStretch', 'midAdd'].forEach((id) => {
    $(id).onclick = () => {
      state.midMode = id === 'midAdd' ? 'add' : 'stretch';
      $('midStretch').setAttribute('aria-pressed', String(state.midMode === 'stretch'));
      $('midAdd').setAttribute('aria-pressed', String(state.midMode === 'add'));
    };
  });

  /* ------------------------------------------------------------------ */
  /* Zone et poignées d'édition                                          */
  /* ------------------------------------------------------------------ */
  function clearZone() {
    state.ring = null; state.kind = null;
    if (state.zoneLayer) { map.removeLayer(state.zoneLayer); state.zoneLayer = null; }
    state.parcels.clear();
    state.parcelLayer.clearLayers();
    state.commune = null;
    state.ds = null;
    renderGrips();
    renderZone();
  }

  function setZone(ring, kind) {
    if (kind !== 'parcelles') { state.parcels.clear(); state.parcelLayer.clearLayers(); }
    state.ring = ring;
    state.kind = kind;
    state.ds = null;
    if (state.zoneLayer) map.removeLayer(state.zoneLayer);
    state.zoneLayer = L.polygon(ring.map(toWGS), Object.assign(zoneStyle(), { interactive: false })).addTo(map);
    renderGrips();
    renderZone();
  }

  const gripIcon = (mid) => L.divIcon({ className: mid ? 'grip mid' : 'grip', iconSize: mid ? [12, 8] : [12, 12], iconAnchor: mid ? [6, 4] : [6, 6] });
  let grips = { v: [], m: [] };
  let dragging = null;

  function midOf(i) {
    const r = state.ring, a = r[i], b = r[(i + 1) % r.length];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }

  function renderGrips() {
    state.gripLayer.clearLayers();
    grips = { v: [], m: [] };
    if (!state.ring || state.mode === 'rect' || state.mode === 'poly' || state.busy) return;
    const ring = state.ring;
    ring.forEach((p, i) => {
      const m = L.marker(toWGS(p), { icon: gripIcon(false), draggable: true, keyboard: false, zIndexOffset: 500 });
      m.bindTooltip('Glisser pour déplacer · clic droit pour supprimer', { direction: 'top', offset: [0, -8], className: 'grip-tip' });
      m.on('dragstart', () => { dragging = { type: 'vertex', i, marker: m }; m.closeTooltip(); });
      m.on('drag', (e) => { state.ring[i] = toL93(e.target.getLatLng()); updateZoneGeom(); });
      m.on('dragend', endDrag);
      m.on('contextmenu', (e) => {
        L.DomEvent.stop(e);
        if (state.ring.length <= 3) { tip('Une zone garde au moins trois sommets.'); setTimeout(() => tip(''), 2000); return; }
        state.ring.splice(i, 1);
        afterEdit();
      });
      m.addTo(state.gripLayer);
      grips.v.push(m);
    });
    ring.forEach((p, i) => {
      const m = L.marker(toWGS(midOf(i)), { icon: gripIcon(true), draggable: true, keyboard: false, zIndexOffset: 400 });
      m.bindTooltip('Glisser : étirer le côté · Ctrl + glisser : ajouter un sommet', { direction: 'top', offset: [0, -6], className: 'grip-tip' });
      m.on('dragstart', (e) => {
        m.closeTooltip();
        const add = (state.midMode === 'add') !== state.ctrl;
        if (add) {
          state.ring.splice(i + 1, 0, midOf(i));
          dragging = { type: 'add', idx: i + 1, marker: m };
        } else {
          const j = (i + 1) % state.ring.length;
          const a = state.ring[i].slice(), b = state.ring[j].slice();
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          dragging = { type: 'stretch', i, j, a, b, start: midOf(i), nx: -(b[1] - a[1]) / len, ny: (b[0] - a[0]) / len, marker: m };
        }
      });
      m.on('drag', (e) => {
        const cur = toL93(e.target.getLatLng());
        if (!dragging) return;
        if (dragging.type === 'add') state.ring[dragging.idx] = cur;
        else {
          let dx = cur[0] - dragging.start[0], dy = cur[1] - dragging.start[1];
          if (!state.shift) {
            // Déplacement perpendiculaire au côté : les côtés voisins restent alignés (rectangle conservé).
            const d = dx * dragging.nx + dy * dragging.ny;
            dx = d * dragging.nx; dy = d * dragging.ny;
          }
          state.ring[dragging.i] = [dragging.a[0] + dx, dragging.a[1] + dy];
          state.ring[dragging.j] = [dragging.b[0] + dx, dragging.b[1] + dy];
        }
        updateZoneGeom();
      });
      m.on('dragend', endDrag);
      m.addTo(state.gripLayer);
      grips.m.push(m);
    });
  }

  function updateZoneGeom() {
    if (!state.zoneLayer) return;
    state.zoneLayer.setLatLngs(state.ring.map(toWGS));
    if (grips.v.length === state.ring.length) {
      state.ring.forEach((p, i) => { if (!dragging || grips.v[i] !== dragging.marker) grips.v[i].setLatLng(toWGS(p)); });
      state.ring.forEach((p, i) => { if (!dragging || grips.m[i] !== dragging.marker) grips.m[i].setLatLng(toWGS(midOf(i))); });
    }
    renderZone(true);
  }

  function endDrag() { dragging = null; afterEdit(); }

  function afterEdit() {
    if (state.kind === 'rectangle' && !isAxisRect(state.ring)) state.kind = 'polygone';
    if (state.kind === 'parcelles' || state.kind === 'emprise saisie') state.kind = 'polygone';
    state.ds = null;
    if (state.zoneLayer) state.zoneLayer.setLatLngs(state.ring.map(toWGS));
    renderGrips();
    renderZone();
  }

  function isAxisRect(r) {
    if (r.length !== 4) return false;
    for (let k = 0; k < 4; k++) {
      const a = r[k], b = r[(k + 1) % 4];
      if (Math.abs(a[0] - b[0]) > 0.01 && Math.abs(a[1] - b[1]) > 0.01) return false;
    }
    return true;
  }

  function renderZone(light) {
    const box = $('zoneInfo');
    $('clearZone').hidden = !state.ring;
    $('editHelp').hidden = !state.ring;
    $('exportBtn').disabled = !state.ring || state.busy;
    if (!state.ring) {
      box.className = 'zone-empty';
      box.textContent = 'Aucune zone. Recherchez une adresse, puis tracez un rectangle, un polygone ou sélectionnez des parcelles.';
      return;
    }
    const a = T.ringArea(state.ring), bb = T.ringBBox(state.ring);
    const c = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
    const rows = [
      ['Type', state.kind + (state.parcels.size ? ' (' + state.parcels.size + ' parcelle' + (state.parcels.size > 1 ? 's' : '') + ')' : '')],
      ['Surface', areaTxt(a)],
      ['Emprise', fr(bb[2] - bb[0]) + ' × ' + fr(bb[3] - bb[1]) + ' m'],
      ['Sommets', String(state.ring.length)],
      ['Centre X', fr(c[0], 2)],
      ['Centre Y', fr(c[1], 2)],
    ];
    if (state.commune) rows.splice(1, 0, ['Commune', state.commune]);
    box.className = 'zone-card';
    box.innerHTML = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      box.append(dt, dd);
    }
    if ((bb[2] - bb[0]) * (bb[3] - bb[1]) > MAX_AREA) {
      const p = document.createElement('p');
      p.className = 'zone-warn';
      p.textContent = 'Emprise trop grande : 4 km² au maximum. Réduisez la zone.';
      box.append(p);
      $('exportBtn').disabled = true;
    }
    if (!light) {
      $('bxmin').value = bb[0].toFixed(2); $('bymin').value = bb[1].toFixed(2);
      $('bxmax').value = bb[2].toFixed(2); $('bymax').value = bb[3].toFixed(2);
    }
  }

  $('applyBBox').onclick = () => {
    const v = ['bxmin', 'bymin', 'bxmax', 'bymax'].map((id) => parseFloat(String($(id).value).replace(',', '.')));
    if (v.some((n) => !isFinite(n)) || v[2] <= v[0] || v[3] <= v[1]) { log('Emprise invalide : vérifiez que X max > X min et Y max > Y min.', 'err'); return; }
    if (v[0] < 50000 || v[2] > 1300000 || v[1] < 6000000 || v[3] > 7200000) { log('Ces coordonnées ne sont pas en Lambert-93 (France métropolitaine).', 'err'); return; }
    setZone([[v[0], v[1]], [v[2], v[1]], [v[2], v[3]], [v[0], v[3]]], 'emprise saisie');
    map.fitBounds(state.zoneLayer.getBounds(), { padding: [30, 30] });
  };

  /* ------------------------------------------------------------------ */
  /* Sélection par parcelles                                             */
  /* ------------------------------------------------------------------ */
  function partsOf(geom) {
    if (!geom) return [];
    if (geom.type === 'Polygon') return [geom.coordinates];
    if (geom.type === 'MultiPolygon') return geom.coordinates;
    return [];
  }

  async function pickParcel(latlng) {
    const xy = toL93(latlng);
    const d = 0.5;
    try {
      tip('Recherche de la parcelle…');
      const feats = await wfs(SRC.parcelle, [xy[0] - d, xy[1] - d, xy[0] + d, xy[1] + d], 50);
      const hit = feats.find((f) => partsOf(f.geometry).some((poly) => T.pointInRing(xy[0], xy[1], poly[0])));
      tip('Cliquez les parcelles à inclure (re-cliquez pour retirer).');
      if (!hit) { log('Pas de parcelle cadastrée à cet endroit (domaine public, voirie…).', 'warn'); return; }
      const p = hit.properties;
      const key = p.idu || hit.id;
      if (state.parcels.has(key)) state.parcels.delete(key); else state.parcels.set(key, hit);
      state.commune = p.nom_com || state.commune;
      refreshParcels();
    } catch (err) {
      tip('Cliquez les parcelles à inclure (re-cliquez pour retirer).');
      log('Cadastre injoignable : ' + err.message, 'err');
    }
  }

  function refreshParcels() {
    state.parcelLayer.clearLayers();
    if (!state.parcels.size) { clearZone(); return; }
    let all = [];
    for (const f of state.parcels.values()) {
      partsOf(f.geometry).forEach((poly) => {
        all = all.concat(poly[0]);
        L.polygon(poly[0].map(toWGS), { color: cssVar('--zone', '#00B4FF'), weight: 3, fillOpacity: 0.28, interactive: false }).addTo(state.parcelLayer);
      });
    }
    // Zone = rectangle englobant des parcelles + 10 m, pour saisir l'environnement immédiat (voirie, accès).
    const bb = T.ringBBox(all, 10);
    setZone([[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]], 'parcelles');
  }

  /* ------------------------------------------------------------------ */
  /* Recherche d'adresse (géocodage Géoplateforme)                      */
  /* ------------------------------------------------------------------ */
  $('searchForm').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('searchInput').value.trim();
    const ul = $('searchResults');
    if (q.length < 3) return;
    const item = (txt, fn) => {
      const li = document.createElement('li'); const b = document.createElement('button');
      b.type = 'button'; b.textContent = txt; if (fn) b.onclick = fn; else b.disabled = true;
      li.append(b); ul.append(li);
    };
    ul.hidden = false; ul.innerHTML = '';
    item('Recherche…');
    try {
      const r = await fetchRetry(GPF + '/geocodage/search?limit=6&q=' + encodeURIComponent(q));
      const js = await r.json();
      ul.innerHTML = '';
      if (!js.features || !js.features.length) { item('Aucun résultat'); return; }
      for (const f of js.features) {
        item(f.properties.label + (f.properties.context ? ' — ' + f.properties.context : ''), () => {
          const [lon, lat] = f.geometry.coordinates;
          map.setView([lat, lon], f.properties.type === 'municipality' ? 15 : 18);
          ul.hidden = true;
        });
      }
    } catch (err) {
      ul.innerHTML = '';
      item('Service de recherche injoignable (' + err.message + ')');
    }
  };

  /* ------------------------------------------------------------------ */
  /* Accès réseau                                                        */
  /* ------------------------------------------------------------------ */
  async function fetchRetry(url, tries) {
    tries = tries || 3;
    let last;
    for (let k = 0; k < tries; k++) {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 90000);
      try {
        const r = await fetch(url, { signal: ctl.signal });
        clearTimeout(to);
        if (r.ok) return r;
        last = new Error('HTTP ' + r.status);
        if (r.status >= 400 && r.status < 500 && r.status !== 429) {
          const txt = await r.text();
          const m = txt.match(/<(?:ows:)?ExceptionText>([\s\S]*?)<\//) || txt.match(/<ServiceException[^>]*>([\s\S]*?)<\//);
          throw Object.assign(new Error(m ? m[1].trim() : 'HTTP ' + r.status), { fatal: true });
        }
      } catch (e) {
        clearTimeout(to);
        if (e.fatal) throw e;
        last = e.name === 'AbortError' ? new Error('délai dépassé') : e;
      }
      await new Promise((res) => setTimeout(res, 1500 * (k + 1)));
    }
    throw last;
  }

  async function pool(tasks, n) {
    const out = new Array(tasks.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
      while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); }
    }));
    return out;
  }

  /** Requête WFS paginée, géométries en Lambert-93. */
  async function wfs(typename, bb, max) {
    max = max || 50000;
    const page = Math.min(5000, max);
    const feats = [];
    for (let start = 0; start < max; start += page) {
      const url = WFS + '?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=' + encodeURIComponent(typename) +
        '&OUTPUTFORMAT=application/json&SRSNAME=EPSG:2154&BBOX=' + bb.map((v) => v.toFixed(2)).join(',') + ',EPSG:2154' +
        '&COUNT=' + page + '&STARTINDEX=' + start;
      const r = await fetchRetry(url);
      const js = await r.json();
      const f = js.features || [];
      feats.push(...f);
      if (f.length < page) break;
    }
    return feats;
  }

  /** Grille altimétrique Float32 depuis le WMS-R (FORMAT=image/tiff), découpée en tuiles. */
  async function fetchGrid(layer, bb, res, onTile) {
    const w = Math.round((bb[2] - bb[0]) / res), h = Math.round((bb[3] - bb[1]) / res);
    const g = T.makeGrid(bb[0], bb[3], res, w, h, NaN);
    const tasks = [];
    let done = 0;
    const nt = Math.ceil(w / MAX_TILE) * Math.ceil(h / MAX_TILE);
    for (let ty = 0; ty < h; ty += MAX_TILE) {
      for (let tx = 0; tx < w; tx += MAX_TILE) {
        const tw = Math.min(MAX_TILE, w - tx), th = Math.min(MAX_TILE, h - ty);
        const x0 = bb[0] + tx * res, y1 = bb[3] - ty * res;
        const tb = [x0, y1 - th * res, x0 + tw * res, y1];
        tasks.push(async () => {
          const url = WMSR + '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=' + layer + '&STYLES=&CRS=EPSG:2154' +
            '&BBOX=' + tb.map((v) => v.toFixed(3)).join(',') + '&WIDTH=' + tw + '&HEIGHT=' + th + '&FORMAT=image/tiff';
          const r = await fetchRetry(url);
          const buf = await r.arrayBuffer();
          const sig = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
          const isTiff = (sig[0] === 0x49 && sig[1] === 0x49) || (sig[0] === 0x4d && sig[1] === 0x4d);
          if (!isTiff) {
            const txt = new TextDecoder().decode(buf.slice(0, 2000));
            const m = txt.match(/<(?:ows:)?ExceptionText>([\s\S]*?)<\//) || txt.match(/<ServiceException[^>]*>([\s\S]*?)<\//);
            throw new Error(m ? m[1].trim() : 'réponse inattendue du service altimétrique');
          }
          const tiff = await GeoTIFF.fromArrayBuffer(buf);
          const img = await tiff.getImage();
          const ras = await img.readRasters({ interleave: true });
          const iw = img.getWidth(), ih = img.getHeight();
          const nd = img.getGDALNoData();
          for (let r2 = 0; r2 < Math.min(th, ih); r2++) {
            for (let c2 = 0; c2 < Math.min(tw, iw); c2++) {
              const z = ras[r2 * iw + c2];
              g.data[(ty + r2) * w + tx + c2] = (nd !== null && z === nd) ? NaN : z;
            }
          }
          done++;
          if (onTile) onTile(done, nt);
        });
      }
    }
    await pool(tasks, 4);
    return g;
  }

  /** Orthophoto Lambert-93 assemblée dans un canvas. */
  async function fetchOrtho(bb, maxSide) {
    const ext = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
    const res = Math.max(0.2, ext / maxSide);
    const w = Math.round((bb[2] - bb[0]) / res), h = Math.round((bb[3] - bb[1]) / res);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const tasks = [];
    const T2 = 2000;
    for (let ty = 0; ty < h; ty += T2) {
      for (let tx = 0; tx < w; tx += T2) {
        const tw = Math.min(T2, w - tx), th = Math.min(T2, h - ty);
        const x0 = bb[0] + tx * res, y1 = bb[3] - ty * res;
        const tb = [x0, y1 - th * res, x0 + tw * res, y1];
        tasks.push(async () => {
          let blob = null;
          for (const layer of [SRC.ortho, SRC.orthoFallback]) {
            try {
              const url = WMSR + '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=' + layer + '&STYLES=&CRS=EPSG:2154' +
                '&BBOX=' + tb.map((v) => v.toFixed(3)).join(',') + '&WIDTH=' + tw + '&HEIGHT=' + th + '&FORMAT=image/jpeg';
              const r = await fetchRetry(url, 2);
              blob = await r.blob();
              if (blob.type.indexOf('image') === 0) break;
              blob = null;
            } catch (e) { blob = null; }
          }
          if (!blob) throw new Error('orthophoto indisponible');
          const bmp = await createImageBitmap(blob);
          ctx.drawImage(bmp, tx, ty, tw, th);
        });
      }
    }
    await pool(tasks, 3);
    return { canvas: cv, res, w, h, xmin: bb[0], ymax: bb[3] };
  }


  /* ------------------------------------------------------------------ */
  /* Journal et progression                                              */
  /* ------------------------------------------------------------------ */
  function log(msg, cls) {
    const li = document.createElement('li');
    li.className = cls || '';
    const s = document.createElement('span'); s.textContent = msg;
    li.append(s);
    $('log').append(li);
    return li;
  }
  /** Barre de progression + pourcentage + étape en cours. f = null masque l'ensemble. */
  function progress(f, label) {
    $('progress').hidden = f === null;
    if (f === null) return;
    const pct = Math.max(0, Math.min(100, Math.round(f * 100)));
    $('bar').firstElementChild.style.width = pct + '%';
    $('barPct').textContent = pct + ' %';
    if (label !== undefined) $('barLabel').textContent = label;
  }
  const frame = () => new Promise((r) => setTimeout(r, 0));
  const frDate = (s) => { if (!s) return ''; const d = String(s).slice(0, 10).split('-'); return d.length === 3 ? d[2] + '/' + d[1] + '/' + d[0] : String(s); };

  /* ------------------------------------------------------------------ */
  /* Cases « tout cocher » par chapitre                                  */
  /* ------------------------------------------------------------------ */
  document.querySelectorAll('fieldset.group').forEach((fs) => {
    const all = fs.querySelector('.allbox');
    const items = Array.from(fs.querySelectorAll('input[type="checkbox"]:not(.allbox)'));
    const sync = () => {
      const n = items.filter((i) => i.checked).length;
      all.checked = n === items.length;
      all.indeterminate = n > 0 && n < items.length;
    };
    all.addEventListener('change', () => {
      items.forEach((i) => { i.checked = all.checked; });
      state.ds = null;
      sync();
    });
    items.forEach((i) => i.addEventListener('change', sync));
    sync();
  });

  /* ------------------------------------------------------------------ */
  /* 1. Préparation : récupération et calculs de l'aperçu                */
  /* ------------------------------------------------------------------ */
  const PREVIEW_PTS = 60000;     // au-delà, l'aperçu affiche un semis allégé
  const PREVIEW_GRID = 700;      // côté max (en mailles) de la grille servant aux courbes de l'aperçu
  const PREVIEW_LEVELS = 150;    // nombre max de niveaux de courbes dans l'aperçu
  const HEAVY_PTS = 150000;      // au-delà, on prévient que l'export final sera long

  function readOptions() {
    return {
      points: $('cPoints').checked, contours: $('cContours').checked, tin: $('cTin').checked, asc: $('cAsc').checked,
      parcelles: $('cParcelles').checked, cadBati: $('cCadBati').checked, bornes: $('cBornes').checked,
      bati: $('cBati').checked, routes: $('cRoutes').checked, hydro: $('cHydro').checked, fer: $('cFer').checked, vege: $('cVege').checked,
      ortho: $('cOrtho').checked,
      step: parseFloat($('step').value), interval: parseFloat($('interval').value), master: parseInt($('master').value, 10),
      smooth: parseInt($('smooth').value, 10), margin: parseFloat($('margin').value), scale: parseInt($('scale').value, 10),
      start: parseInt($('startId').value, 10) || 0,
      altText: $('cAltText').checked, matText: $('cMatText').checked,
    };
  }

  $('exportBtn').onclick = async () => {
    try {
      const opt = readOptions();
      const key = JSON.stringify([state.ring, opt]);
      if (!state.ds || state.ds.key !== key) {
        state.ds = await prepare(opt);
        state.ds.key = key;
      }
      openPreview(state.ds);
    } catch (err) {
      log('Préparation interrompue : ' + err.message, 'err');
      console.error(err);
    } finally {
      state.busy = false; progress(null); renderGrips(); renderZone();
    }
  };

  /** Paramètres des courbes à la précision demandée. */
  function contourParams(ds, light) {
    const o = ds.opt, g = ds.grid;
    let factor = Math.max(1, Math.round(Math.max(ds.res, Math.min(1, o.interval * 2)) / ds.res));
    let interval = o.interval;
    if (light) {
      factor = Math.max(factor, Math.ceil(Math.max(g.w, g.h) / PREVIEW_GRID));
      const levels = (ds.stats.zmax - ds.stats.zmin) / o.interval;
      if (levels > PREVIEW_LEVELS) interval = o.interval * Math.ceil(levels / PREVIEW_LEVELS);
    }
    return { factor, interval };
  }

  function computeContours(ds, prm) {
    const o = ds.opt;
    let cg = ds.grid;
    if (prm.factor > 1) cg = T.downsample(cg, prm.factor);
    cg = T.maskGrid(cg, ds.ring, o.margin + cg.res);
    if (o.smooth) cg = T.smoothGrid(cg, o.smooth);
    return T.contours(cg, prm.interval, { masterEvery: o.master, simplify: Math.min(0.1, cg.res * 0.2) });
  }

  async function prepare(opt) {
    if (!state.ring) throw new Error('aucune zone');
    state.busy = true;
    renderGrips(); renderZone();
    $('log').innerHTML = '';
    progress(0.01, 'Préparation…');

    const ring = state.ring.map((p) => p.slice());
    const zoneBB = T.ringBBox(ring, opt.margin);

    // Résolution du MNT : 0,50 m natif, dégradé pour les grandes emprises.
    const extArea = (zoneBB[2] - zoneBB[0]) * (zoneBB[3] - zoneBB[1]);
    let res = 0.5;
    while (extArea / (res * res) > 8e6) res *= 2;
    const pad = Math.max(res * 4, 2);
    // Emprise calée pour que les centres de mailles tombent sur les multiples du pas,
    // comme la grille native de l'IGN (0,50 m) : les altitudes ne sont pas rééchantillonnées.
    const bb = [
      Math.floor((zoneBB[0] - pad) / res) * res - res / 2, Math.floor((zoneBB[1] - pad) / res) * res - res / 2,
      Math.ceil((zoneBB[2] + pad) / res) * res + res / 2, Math.ceil((zoneBB[3] + pad) / res) * res + res / 2,
    ];
    const step = Math.max(opt.step, res);
    if (step !== opt.step) log('Pas du semis porté à ' + fr(step, 1) + ' m, cohérent avec la taille de la zone.', 'warn');
    const estPts = T.ringArea(ring) / (step * step);
    if ((opt.points || opt.tin) && estPts > MAX_POINTS) {
      throw new Error('environ ' + fr(estPts) + ' points : choisissez un pas plus grand ou réduisez la zone.');
    }
    if ((opt.points || opt.tin) && estPts > HEAVY_PTS) {
      log('Précision élevée : environ ' + fr(estPts) + ' points. La prévisualisation sera allégée et l\'export final peut prendre une à plusieurs minutes.', 'warn');
    }

    const stats = { estPts };
    const vectors = {};

    // Terrain : toujours récupéré, il sert aussi à la vue 3D.
    progress(0.03, 'MNT LiDAR HD');
    const li = log('MNT LiDAR HD au pas de ' + fr(res, 2) + ' m…', 'run');
    const grid = await fetchGrid(SRC.mntLidar, bb, res, (d, n) => progress(0.03 + 0.37 * d / n, 'MNT LiDAR HD : tuile ' + d + '/' + n));
    let st = T.gridStats(grid);
    stats.lidar = st.coverage;
    if (st.coverage < 0.999) {
      li.className = 'warn';
      li.firstChild.textContent = 'MNT LiDAR HD : couverture ' + fr(st.coverage * 100, 1) + ' %. Complément RGE ALTI…';
      progress(0.4, 'Complément RGE ALTI');
      try {
        const rge = await fetchGrid(SRC.mntRge, bb, res);
        const n = T.fillGaps(grid, rge);
        stats.rge = n / grid.data.length;
        st = T.gridStats(grid);
        log('Complété par RGE ALTI : ' + fr(stats.rge * 100, 1) + ' % des mailles.', st.coverage > 0.99 ? 'ok' : 'warn');
      } catch (e) {
        log('RGE ALTI indisponible (' + e.message + ').', 'warn');
      }
    } else {
      li.className = 'ok';
      li.firstChild.textContent = 'MNT LiDAR HD reçu : ' + grid.w + ' × ' + grid.h + ' mailles de ' + fr(res, 2) + ' m.';
    }
    if (st.valid === 0) throw new Error('aucune altitude disponible sur cette zone (hors couverture ou zone à accès restreint ZICAD).');
    stats.zmin = st.min; stats.zmax = st.max;

    // Vecteurs et millésimes, en parallèle
    progress(0.42, 'Cadastre, BD TOPO et millésimes');
    const vtasks = [];
    const vecBB = [zoneBB[0] - 5, zoneBB[1] - 5, zoneBB[2] + 5, zoneBB[3] + 5];
    let vdone = 0;
    const want = (flag, key, layer, label) => {
      if (!flag) return;
      vtasks.push(async () => {
        try {
          vectors[key] = await wfs(layer, vecBB);
          log(label + ' : ' + vectors[key].length, 'ok');
        } catch (e) {
          log(label + ' : échec (' + e.message + ')', 'warn');
        }
        vdone++;
        progress(0.42 + 0.16 * vdone / vtasks.length, 'Cadastre et BD TOPO : ' + vdone + '/' + vtasks.length);
      });
    };
    want(opt.parcelles, 'parcelles', SRC.parcelle, 'Parcelles cadastrales');
    want(opt.cadBati, 'cadBati', SRC.cadBati, 'Bâtiments cadastrés');
    want(opt.bornes, 'bornes', SRC.borne, 'Bornes');
    want(opt.bati, 'bati', SRC.bati, 'Bâtiments BD TOPO');
    want(opt.routes, 'routes', SRC.route, 'Tronçons de voirie');
    want(opt.hydro, 'hydro', SRC.hydro, 'Cours d\'eau et fossés');
    want(opt.hydro, 'hydroS', SRC.hydroS, 'Surfaces en eau');
    want(opt.fer, 'fer', SRC.fer, 'Voies ferrées');
    want(opt.vege, 'vege', SRC.vege, 'Végétation');
    const meta = {};
    vtasks.push(async () => { try { meta.lidar = await wfs(SRC.lidarMeta, bb, 500); } catch (e) { meta.lidar = null; } vdone++; });
    if (opt.ortho) vtasks.push(async () => { try { meta.ortho = await wfs(SRC.orthoMeta, bb, 500); } catch (e) { meta.ortho = null; } vdone++; });
    log('Cadastre, BD TOPO et dates des données…', 'run');
    await pool(vtasks, 4);
    if (state.parcels.size) vectors.projet = Array.from(state.parcels.values());
    if (!state.commune && vectors.parcelles && vectors.parcelles.length) { state.commune = vectors.parcelles[0].properties.nom_com || null; renderZone(); }
    const dates = buildDates(meta, vectors, stats);
    dates.lines.forEach((l) => log(l.label + ' : ' + l.value, 'ok'));

    // Orthophoto (sur l'emprise du MNT, pour habiller la 3D)
    let ortho = null;
    if (opt.ortho) {
      progress(0.6, 'Orthophoto');
      const lo = log('Orthophoto…', 'run');
      try {
        ortho = await fetchOrtho(bb, 4000);
        lo.className = 'ok';
        lo.firstChild.textContent = 'Orthophoto : ' + ortho.w + ' × ' + ortho.h + ' px, ' + fr(ortho.res * 100) + ' cm/pixel.';
      } catch (e) {
        lo.className = 'warn';
        lo.firstChild.textContent = 'Orthophoto non récupérée (' + e.message + ').';
      }
    }

    const ds = { ring, zoneBB, bb, res, step, opt, stats, grid, vectors, ortho, dates, commune: state.commune, full: null };

    // Aperçu : allégé si la précision demandée est lourde, pour ne pas bloquer le navigateur.
    progress(0.75, 'Calcul de l\'aperçu');
    await frame();
    const view = { step, interval: opt.interval, semis: null, faces: null, lines: null, lightPts: false, lightContours: false };
    if (opt.points || opt.tin) {
      if (estPts > PREVIEW_PTS) { view.step = step * Math.ceil(Math.sqrt(estPts / PREVIEW_PTS)); view.lightPts = true; }
      view.semis = T.samplePoints(grid, { step: view.step, ring, margin: opt.margin, start: opt.start });
      if (opt.tin) view.faces = T.gridTIN(view.semis, ring, opt.margin);
      log('Semis : ' + (view.lightPts ? 'environ ' + fr(estPts) + ' points au pas de ' + fr(step, 2) + ' m (aperçu au pas de ' + fr(view.step, 2) + ' m).' : fr(view.semis.points.length) + ' points au pas de ' + fr(step, 2) + ' m.'), 'ok');
    }
    progress(0.85, 'Courbes de niveau de l\'aperçu');
    await frame();
    if (opt.contours) {
      const full = contourParams(ds, false), prm = contourParams(ds, true);
      view.lightContours = prm.factor !== full.factor || prm.interval !== full.interval;
      view.interval = prm.interval;
      view.lines = computeContours(ds, prm);
      log('Courbes de niveau : équidistance ' + fr(opt.interval, 2) + ' m' + (view.lightContours ? ' (aperçu simplifié, équidistance ' + fr(prm.interval, 2) + ' m).' : ', ' + fr(view.lines.length) + ' polylignes.'), 'ok');
    }
    view.light = view.lightPts || view.lightContours;
    ds.view = view;
    if (!view.light) ds.full = { semis: view.semis, faces: view.faces, lines: view.lines };
    if (view.light) log('Aperçu allégé pour rester fluide. L\'export final sera calculé à la précision demandée.', 'warn');
    progress(1, 'Prêt');
    log('Données prêtes : ouverture de la prévisualisation.', 'ok');
    return ds;
  }

  /** Millésimes des données IGN interrogées. */
  function buildDates(meta, vectors, stats) {
    const out = { lines: [] };
    const span = (arr) => {
      const v = arr.filter(Boolean).map((s) => String(s).slice(0, 10)).sort();
      if (!v.length) return null;
      return v[0] === v[v.length - 1] ? frDate(v[0]) : frDate(v[0]) + ' au ' + frDate(v[v.length - 1]);
    };
    if (meta.lidar && meta.lidar.length) {
      const p = meta.lidar.map((f) => f.properties || {});
      const vol = span(p.flatMap((x) => [x.date_debut_acquisition, x.date_fin_acquisition]));
      const ed = span(p.map((x) => x.date_edition));
      const missions = Array.from(new Set(p.map((x) => x.code_mission).filter(Boolean)));
      out.lidar = { vol, edition: ed, missions, dalles: p.length };
      out.lines.push({ label: 'LiDAR HD', value: 'vol ' + (vol || 'inconnu') + (ed ? ', édition ' + ed : '') + (missions.length ? ' (mission ' + missions.join(', ') + ')' : '') });
    } else {
      out.lines.push({ label: 'LiDAR HD', value: 'date non disponible pour cette zone' + (stats.rge ? ' (complément RGE ALTI, millésimes variables)' : '') });
    }
    if (meta.ortho && meta.ortho.length) {
      const p = meta.ortho.map((f) => f.properties || {});
      const vol = span(p.map((x) => x.date_vol));
      const resCm = Array.from(new Set(p.map((x) => x.res).filter(Boolean)));
      out.ortho = { vol, res: resCm };
      out.lines.push({ label: 'Orthophoto', value: 'prise de vue ' + (vol || 'inconnue') + (resCm.length ? ' (' + resCm.join(', ') + ' cm)' : '') });
    } else if (meta.ortho !== undefined) {
      out.lines.push({ label: 'Orthophoto', value: 'date non disponible' });
    }
    const bd = [];
    for (const k of ['bati', 'routes', 'hydro', 'hydroS', 'fer', 'vege']) {
      for (const f of vectors[k] || []) { const p = f.properties || {}; bd.push(p.date_modification || p.date_creation); }
    }
    const bdv = bd.filter(Boolean).map((s) => String(s).slice(0, 10)).sort();
    if (bdv.length) {
      out.bdtopo = frDate(bdv[bdv.length - 1]);
      out.lines.push({ label: 'BD TOPO', value: 'objets mis à jour jusqu\'au ' + out.bdtopo });
    }
    if (vectors.parcelles || vectors.cadBati || vectors.bornes) {
      out.cadastre = frDate(new Date().toISOString());
      out.lines.push({ label: 'Cadastre', value: 'édition en ligne consultée le ' + out.cadastre + ' (mise à jour trimestrielle IGN/DGFiP)' });
    }
    return out;
  }

  /** Semis, TIN et courbes à la précision demandée (calculés à l'export si l'aperçu était allégé). */
  async function computeFull(ds, status) {
    if (ds.full) return ds.full;
    const o = ds.opt, full = { semis: null, faces: null, lines: null };
    if (o.points || o.tin) {
      status('Calcul du semis complet…');
      await frame();
      full.semis = T.samplePoints(ds.grid, { step: ds.step, ring: ds.ring, margin: o.margin, start: o.start });
      if (o.tin) { status('Triangulation du MNT…'); await frame(); full.faces = T.gridTIN(full.semis, ds.ring, o.margin); }
    }
    if (o.contours) {
      status('Calcul des courbes de niveau à l\'équidistance demandée…');
      await frame();
      full.lines = computeContours(ds, contourParams(ds, false));
    }
    ds.full = full;
    return full;
  }

  /* ------------------------------------------------------------------ */
  /* 2. Prévisualisation                                                 */
  /* ------------------------------------------------------------------ */
  function layerDefs(ds) {
    const v = ds.vectors, o = ds.opt, w = ds.view;
    const n = (a) => (a ? a.length : 0);
    const has = (a) => !!a && a.length > 0;
    const ptsCount = w.lightPts ? '≈ ' + fr(ds.stats.estPts) : (w.semis ? w.semis.points.length : 0);
    return {
      ortho: { group: 'Image', label: 'Orthophoto', color: '#7d8a6a', available: !!ds.ortho, on: true },
      points: { group: 'Terrain naturel', label: 'Points TN', color: '#d81b60', count: ptsCount, available: o.points && !!w.semis, on: true,
        note: w.lightPts ? 'Aperçu au pas de ' + fr(w.step, 2) + ' m, export au pas de ' + fr(ds.step, 2) + ' m' : null },
      altText: { group: 'Terrain naturel', label: 'Altitudes écrites (DXF)', color: null, available: o.points && !!w.semis, on: o.altText, exported: false },
      contours: { group: 'Terrain naturel', label: 'Courbes de niveau', color: '#b8641f', count: w.lightContours ? null : n(w.lines), available: !!w.lines, on: true,
        note: w.lightContours ? 'Aperçu simplifié, export à l\'équidistance de ' + fr(o.interval, 2) + ' m' : null },
      tin: { group: 'Terrain naturel', label: 'MNT triangulé', color: '#7a7a7a', count: w.lightPts ? null : (w.faces ? w.faces.length / 3 : 0), available: !!w.faces, on: true, note: 'LandXML + faces 3D du DXF' },
      asc: { group: 'Terrain naturel', label: 'Grille MNT brute (.asc)', color: null, available: true, on: o.asc },
      parcelles: { group: 'Cadastre', label: 'Parcelles et numéros', color: '#d32f2f', count: n(v.parcelles), available: has(v.parcelles), on: true },
      projet: { group: 'Cadastre', label: 'Parcelles sélectionnées', color: cssVar('--zone', '#00B4FF'), count: n(v.projet), available: has(v.projet), on: true },
      cadBati: { group: 'Cadastre', label: 'Bâtiments cadastrés', color: '#6b6b6b', count: n(v.cadBati), available: has(v.cadBati), on: true },
      bornes: { group: 'Cadastre', label: 'Bornes', color: '#d32f2f', count: n(v.bornes), available: has(v.bornes), on: true },
      bati: { group: 'BD TOPO', label: 'Bâtiments', color: '#3a3a44', count: n(v.bati), available: has(v.bati), on: true },
      routes: { group: 'BD TOPO', label: 'Voirie (axes et noms)', color: '#e3a400', count: n(v.routes), available: has(v.routes), on: true },
      hydro: { group: 'BD TOPO', label: 'Hydrographie', color: '#1e88e5', count: n(v.hydro) + n(v.hydroS), available: has(v.hydro) || has(v.hydroS), on: true },
      fer: { group: 'BD TOPO', label: 'Voies ferrées', color: '#6d4c41', count: n(v.fer), available: has(v.fer), on: true },
      vege: { group: 'BD TOPO', label: 'Végétation', color: '#2e7d32', count: n(v.vege), available: has(v.vege), on: true },
    };
  }

  function openPreview(ds) {
    const layers = layerDefs(ds);
    TopoPreview.open(ds, layers, (lay, status) => exportFinal(ds, lay, status));
  }

  /* ------------------------------------------------------------------ */
  /* 3. Export final selon les calques retenus                           */
  /* ------------------------------------------------------------------ */
  const textBlob = (parts) => new Blob(Array.isArray(parts) ? parts : [parts], { type: 'text/plain' });

  async function exportFinal(ds, lay, status) {
    const on = (k) => lay[k] && lay[k].available && lay[k].on;
    const o = ds.opt;
    const files = {};
    const name = slug(ds.commune || ('L93_' + Math.round((ds.zoneBB[0] + ds.zoneBB[2]) / 2) + '_' + Math.round((ds.zoneBB[1] + ds.zoneBB[3]) / 2)));
    const date = new Date().toISOString().slice(0, 10);
    const base = 'TN_' + name + '_' + date;
    const th = (2 * o.scale) / 1000; // 2 mm à l'échelle du plan : plafond des textes

    const full = (on('points') || on('tin') || on('contours')) ? await computeFull(ds, status) : {};
    const pts = full.semis ? full.semis.points : null;

    const vectors = {};
    for (const k of ['parcelles', 'projet', 'cadBati', 'bornes', 'bati', 'routes', 'fer', 'vege']) if (on(k)) vectors[k] = ds.vectors[k];
    if (on('hydro')) { vectors.hydro = ds.vectors.hydro; vectors.hydroS = ds.vectors.hydroS; }

    status('Écriture du DXF…');
    await frame();
    const dxfParts = T.buildDXF({
      ring: ds.ring,
      points: pts,
      step: ds.step,
      faces: on('tin') ? full.faces : null,
      contours: on('contours') ? full.lines : null,
      vectors,
    }, { textHeight: th, altText: on('altText'), matText: o.matText, faces3d: on('tin'), writePoints: on('points'), decimals: 2 });
    files[base + '.dxf'] = new Blob(dxfParts.map(T.encodeCP1252), { type: 'application/dxf' });

    if (on('points')) {
      status('Écriture du fichier de points…');
      await frame();
      files['points_TN.csv'] = textBlob(T.toPointsTxt(pts));
    }
    if (on('tin')) {
      status('Écriture de la surface LandXML…');
      await frame();
      files['MNT_TN.xml'] = textBlob(T.toLandXML(pts, full.faces, { name: 'TN ' + (ds.commune || ''), cgPoints: on('points') }));
    }
    if (on('asc')) {
      status('Écriture de la grille MNT…');
      await frame();
      const crop = T.maskGrid(ds.grid, ds.ring, o.margin);
      const nm = 'MNT_' + String(ds.res).replace('.', '_') + 'm';
      files[nm + '.asc'] = textBlob(T.toASC(crop));
      files[nm + '.prj'] = T.PRJ_L93;
    }
    if (on('ortho') && ds.ortho) {
      status('Compression de l\'orthophoto…');
      files['orthophoto.jpg'] = await new Promise((res) => ds.ortho.canvas.toBlob(res, 'image/jpeg', 0.88));
      files['orthophoto.jgw'] = T.worldFile(ds.ortho.xmin, ds.ortho.ymax, ds.ortho.res, ds.ortho.res);
      files['orthophoto.prj'] = T.PRJ_L93;
    }
    status('Écriture des GeoJSON…');
    await frame();
    const gj = { emprise: [{ type: 'Feature', properties: { surface_m2: Math.round(T.ringArea(ds.ring)) }, geometry: { type: 'Polygon', coordinates: [ds.ring.concat([ds.ring[0]])] } }] };
    if (on('points')) gj.points_TN = T.pointsToFeatures(pts);
    if (on('contours')) gj.courbes_niveau = T.contoursToFeatures(full.lines);
    for (const k in vectors) if (vectors[k]) gj[k] = vectors[k];
    for (const k in gj) files['geojson/' + k + '.geojson'] = textBlob(T.toGeoJSON(gj[k], k));

    files['LISEZMOI.txt'] = readme(ds, base, date, lay, full);

    status('Compression de l\'archive… 0 %');
    const zip = new JSZip();
    const dir = zip.folder(base);
    for (const k in files) dir.file(k, files[k]);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      (m) => status('Compression de l\'archive… ' + Math.round(m.percent) + ' %'));
    download(blob, base + '.zip');
    const msg = 'Archive téléchargée : ' + base + '.zip (' + fr(blob.size / 1e6, 1) + ' Mo, ' + Object.keys(files).length + ' fichiers).';
    log(msg, 'ok');
    return msg;
  }

  function slug(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'zone';
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    // Lien de secours si le navigateur bloque le téléchargement automatique.
    const li = log('', 'ok');
    const link = document.createElement('a');
    link.href = url; link.download = name; link.textContent = 'Télécharger à nouveau ' + name;
    link.style.color = 'inherit';
    li.firstChild.replaceWith(link);
  }

  function readme(ds, base, date, lay, full) {
    const on = (k) => lay[k] && lay[k].available && lay[k].on;
    const bb = ds.zoneBB, o = ds.opt, st = ds.stats;
    const f = (v, n) => v.toFixed(n === undefined ? 2 : n);
    const LY = T.LAYERS;
    const kept = Object.keys(lay).filter((k) => on(k)).map((k) => lay[k].label);
    const mk = T.pointMarks(ds.step, (2 * o.scale) / 1000);
    const out = [
      'ExporTopo v' + T.VERSION + ' — export terrain naturel',
      '========================================',
      '',
      'Date de l\'export : ' + date,
      'Commune : ' + (ds.commune || 'non déterminée'),
      'Système : RGF93 v1 / Lambert-93 (EPSG:2154), altitudes NGF-IGN69 (France métropolitaine).',
      'Emprise : X ' + f(bb[0]) + ' à ' + f(bb[2]) + ' ; Y ' + f(bb[1]) + ' à ' + f(bb[3]),
      'Surface de la zone : ' + Math.round(T.ringArea(ds.ring)) + ' m²' + (o.margin ? ' (+ débord de ' + o.margin + ' m)' : ''),
      'Contenu retenu : ' + kept.join(', '),
      '',
      'MILLÉSIMES DES DONNÉES IGN',
    ];
    ds.dates.lines.forEach((l) => out.push('  ' + l.label + ' : ' + l.value));
    out.push('', 'TERRAIN',
      '  MNT source : LiDAR HD IGN au pas de ' + ds.res + ' m (couverture ' + f(st.lidar * 100, 1) + ' %' + (st.rge ? ', complété par RGE ALTI sur ' + f(st.rge * 100, 1) + ' %' : '') + ')',
      '  Altitudes : ' + f(st.zmin) + ' m à ' + f(st.zmax) + ' m');
    if (on('points') && full.semis) out.push('  Semis de points : ' + full.semis.points.length + ' points au pas de ' + ds.step + ' m, calés sur la grille native IGN.',
      '  Repères DXF : croix de ' + f(mk.cross, 3) + ' m, altitudes en texte de ' + f(mk.textHeight, 3) + ' m.');
    if (on('contours') && full.lines) out.push('  Courbes : équidistance ' + o.interval + ' m, maîtresse toutes les ' + o.master + ', lissage ' + o.smooth + ' passe(s).');
    out.push('', 'FICHIERS',
      '  ' + base + '.dxf : plan DXF R12 (AutoCAD, Covadis, Mensura, BricsCAD, Autopiste, QGIS…), coordonnées réelles en mètres.');
    if (on('points')) out.push('  points_TN.csv : « matricule X Y Z » séparés par un espace, sans en-tête (ex. 1 651022.000 6861978.000 120.420).');
    if (on('tin')) out.push('  MNT_TN.xml : surface TIN LandXML 1.2 (Civil 3D, Covadis, Mensura, Trimble, Leica…).');
    if (on('asc')) out.push('  MNT_*.asc : grille altimétrique brute (ESRI ASCII) + .prj.');
    if (on('ortho')) out.push('  orthophoto.jpg + .jgw : image calée en Lambert-93 (insertion d\'image géoréférencée).');
    out.push('  geojson/ : couches pour QGIS (EPSG:2154).',
      '',
      'CALQUES DU DXF',
      '  ' + LY.EMPRISE[0] + ' : limite de la zone',
      '  ' + LY.POINTS[0] + ' / ' + LY.ALTI[0] + ' / ' + LY.MATRICULES[0] + ' : points 3D, altitudes, matricules',
      '  ' + LY.COURBES[0] + ' / ' + LY.COURBES_M[0] + ' / ' + LY.COURBES_TXT[0] + ' : courbes de niveau (polylignes 3D) et cotes',
      '  ' + LY.MNT[0] + ' : MNT triangulé (faces 3D)',
      '  ' + LY.PARCELLES[0] + ' / ' + LY.NUMEROS[0] + ' / ' + LY.PROJET[0] + ' : cadastre, numéros (section + n°), parcelles sélectionnées',
      '  ' + LY.CAD_BATI[0] + ', ' + LY.BORNES[0] + ' : bâti et bornes du plan cadastral',
      '  ' + [LY.BATI, LY.ROUTES, LY.ROUTES_TXT, LY.HYDRO, LY.HYDRO_S, LY.FER, LY.VEGE].map((x) => x[0]).join(', ') + ' : BD TOPO',
      '',
      'PRÉCISION ET LIMITES',
      '  Le MNT LiDAR HD a une précision altimétrique d\'environ 10 cm en terrain dégagé ; elle se dégrade sous',
      '  végétation dense, sur les talus raides, les bordures, murets et caniveaux, et après travaux postérieurs',
      '  à l\'acquisition. Le plan cadastral (PCI) est un document fiscal : sa précision va de quelques décimètres',
      '  à plusieurs mètres et il ne vaut pas bornage. Ces données conviennent aux études de faisabilité,',
      '  esquisse et APS ; un levé topographique par un géomètre reste nécessaire pour le PRO et l\'exécution.',
      '',
      'SOURCES ET LICENCE',
      '  IGN — Géoplateforme : MNT LiDAR HD, RGE ALTI, Parcellaire Express (PCI, DGFiP), BD TOPO, BD ORTHO.',
      '  Licence Ouverte / Open Licence Etalab 2.0. Mention obligatoire sur vos plans : « Source : IGN ».',
      '  Logiciel : ExporTopo v' + T.VERSION + ', licence MIT.');
    return out.join('\r\n') + '\r\n';
  }

  // Le jeu de données préparé n'est plus valable si un réglage change.
  document.querySelectorAll('.panel input, .panel select').forEach((el) => el.addEventListener('change', () => {
    if (el.closest('#searchForm') || el.closest('#bboxDetails')) return;
    state.ds = null;
  }));

  $('appVersion').textContent = 'v' + T.VERSION + ' · MIT';
  renderZone();
  window.TopoApp = { state, setZone, map, openPreview, layerDefs };
})();
