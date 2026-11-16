'use strict';
/* RRL EnviroWatch — Jawa Barat & Banten. Semua angka berasal dari API (Earth Engine / GBIF / GeoJSON). */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const MONTHS = ['Tahunan', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus',
  'September', 'Oktober', 'November', 'Desember'];
const BOUNDS = {
  all: [[-7.85, 105.1], [-5.15, 108.85]],
  jabar: [[-7.85, 106.35], [-5.9, 108.85]],
  banten: [[-7.05, 105.1], [-5.8, 106.8]],
  jakarta: [[-6.38, 106.65], [-5.15, 107.05]],
};
const IUCN_ID = {CR: 'Kritis', EN: 'Genting', VU: 'Rentan', NT: 'Hampir terancam', LC: 'Risiko rendah', DD: 'Kurang data', NE: 'Belum dievaluasi'};

const S = {
  status: null, ready: false, area: 'all', module: 'overview', currentYear: new Date().getFullYear(),
  index: 'ndvi', mask: 'trees', env: 'erosion', bio: 'forest', land: 'index',
  map: null, base: null, boundary: null, layers: new Map(), busy: 0, compare: false,
  gbif: {}, vectors: {}, reloaders: new Map(), skipClick: false,
};

/* ---------------------------------------------------------------- utils */
const fmt = (n, d = 3) => (n === null || n === undefined || !Number.isFinite(Number(n))) ? '—'
  : Number(n).toLocaleString('id-ID', {minimumFractionDigits: d, maximumFractionDigits: d});
const fmtInt = (n) => (n === null || n === undefined) ? '—' : Math.round(n).toLocaleString('id-ID');
const pct = (x) => x === null || x === undefined ? '—' : (x * 100).toLocaleString('id-ID', {maximumFractionDigits: 1}) + '%';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const gradient = (palette) => `linear-gradient(90deg, ${palette.map((p) => '#' + p.replace('#', '')).join(',')})`;

/** GitHub Pages (static) build: map API calls to frozen JSON, or to a remote server when configured. */
function resolveApi(path) {
  if (!window.EW_STATIC) return path;
  const url = new URL(path, 'http://x');
  const p = url.pathname;
  if (p === '/api/status') return 'api/status.json';
  if (p === '/api/layers') return 'api/layers.json';
  if (p === '/api/news') return 'api/news.json';
  let m = p.match(/^\/api\/layers\/([a-z]+)$/);
  if (m) return `api/layers/${m[1]}.json`;
  m = p.match(/^\/api\/biodiversity\/([a-z]+)$/);
  if (m) return `api/biodiversity/${m[1]}_${url.searchParams.get('area') || 'all'}.json`;
  if (window.EW_API_BASE) return window.EW_API_BASE + path;  // live server configured
  // Earth Engine snapshot files produced by scripts/ee_snapshot.py.
  const q = (k, d = '') => url.searchParams.get(k) ?? d;
  const mask = q('mask', 'region') === 'province' ? 'region' : q('mask', 'region');
  if (p === '/api/map') return `api/maps/index_${q('index', 'ndvi')}_${q('year')}_${q('month', '0')}_${q('mask', 'trees') === 'province' ? 'region' : q('mask', 'trees')}.json`;
  if (p === '/api/env/map') return `api/maps/env_${q('layer')}_${q('year')}_${mask}.json`;
  if (p === '/api/water/map') return `api/maps/water_${q('layer')}_${q('year')}_${q('month', '0')}.json`;
  if (p === '/api/statistics') return `api/stats/index_${q('index', 'ndvi')}_${q('year')}_${q('month', '0')}_${q('mask', 'trees') === 'province' ? 'region' : q('mask', 'trees')}_${q('area', 'all')}.json`;
  if (p === '/api/env/statistics') return `api/stats/env_${q('layer')}_${q('year')}_${mask}_${q('area', 'all')}.json`;
  if (p === '/api/env/forestloss') return `api/stats/forestloss_${mask}_${q('area', 'all')}.json`;
  if (p === '/api/env/landchange') return `api/stats/landchange_${q('end', '2025')}_${q('area', 'all')}.json`;
  if (p === '/api/water/statistics') return `api/stats/water_${q('layer')}_${q('year')}_${q('month', '0')}_${q('area', 'all')}_${q('aoi', 'all')}.json`;
  throw new Error('Fitur ini membutuhkan server EnviroWatch (Earth Engine); versi GitHub Pages hanya statis.');
}

function snapshotHint() {
  const sn = S.status?.snapshot;
  if (!sn) return 'Versi GitHub Pages ini belum memiliki snapshot Earth Engine.';
  return `Snapshot GitHub Pages hanya mencakup: indeks citra ${sn.index_map_years.join(' & ')} (statistik ${sn.index_years[0]}–${sn.index_years.at(-1)}), ` +
    `lingkungan & kualitas air ${sn.env_year}, periode tahunan, statistik untuk seluruh wilayah. Pilihan lain tersedia di versi server.`;
}

async function api(path, opts = {}) {
  const res = await fetch(resolveApi(path), opts);
  let body = {};
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (window.EW_STATIC && res.status === 404 && path.startsWith('/api/') && !window.EW_API_BASE) throw new Error(snapshotHint());
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return body;
}

function toast(title, body = '', type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div><b>${esc(title)}</b>${esc(body)}</div><button type="button" aria-label="Tutup">✕</button>`;
  $('button', el).onclick = () => el.remove();
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 9000 : 5000);
}

function busy(on, text = 'Mengolah di Earth Engine…') {
  S.busy = Math.max(0, S.busy + (on ? 1 : -1));
  if (on) $('#mapBusyText').textContent = text;
  $('#mapBusy').classList.toggle('hidden', S.busy === 0);
}

function needEE() {
  if (S.ready) return false;
  if (S.status?.static && (S.status.snapshot || window.EW_API_BASE)) return false;  // snapshot / remote server
  if (S.status?.static) {
    toast('Butuh server EnviroWatch', ' Versi GitHub Pages ini statis. Indeks citra, erosivitas, degradasi, dan kualitas air dihitung Earth Engine di server, jadi hanya tersedia di versi server.', 'err');
  } else {
    toast('Earth Engine belum terhubung',
      ' Isi GOOGLE_CLOUD_PROJECT di .env lalu jalankan HUBUNGKAN_EARTH_ENGINE.bat. Lapisan citra, erosivitas, degradasi, dan kualitas air butuh koneksi ini.', 'err');
  }
  return true;
}

function fillYears(select, from, to, selected) {
  select.innerHTML = '';
  for (let y = to; y >= from; y--) select.add(new Option(String(y), String(y)));
  select.value = String(selected);
}

/* ------------------------------------------------------------------ map */
const BASEMAPS = {
  light: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png', '© OpenStreetMap contributors'],
  sat: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', 'Citra © Esri, Maxar, Earthstar'],
  topo: ['https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', '© OpenStreetMap, SRTM | © OpenTopoMap'],
};

function initMap() {
  if (typeof L === 'undefined') { toast('Pustaka peta gagal dimuat', ' Periksa koneksi internet (Leaflet dari CDN).', 'err'); return; }
  S.map = L.map('map', {zoomControl: false, preferCanvas: false}).fitBounds(BOUNDS.all);
  L.control.zoom({position: 'bottomright'}).addTo(S.map);
  L.control.scale({position: 'bottomright', imperial: false}).addTo(S.map);
  for (const [name, z] of [['rasterA', 250], ['rasterB', 260], ['vectors', 420], ['boundary', 430]]) {
    S.map.createPane(name).style.zIndex = z;
  }
  S.map.getPane('boundary').style.pointerEvents = 'none';
  setBase('light');
  S.map.on('click', onMapClick);
  S.map.on('move zoom resize', updateClip);
}

function setBase(name) {
  if (S.base) S.map.removeLayer(S.base);
  const [url, attribution] = BASEMAPS[name];
  // Only the street map is colour-inverted in dark mode; satellite/topo stay natural.
  S.base = L.tileLayer(url, {maxZoom: name === 'topo' ? 17 : 19, attribution, subdomains: 'abc',
    className: name === 'light' ? 'base-dark' : ''}).addTo(S.map);
  $$('.basemaps button').forEach((b) => b.classList.toggle('on', b.dataset.base === name));
}

/** Register a layer on the map with a chip + optional legend. */
function setLayer(id, layer, {label, color = '#145243', legend = null, opacity = true} = {}) {
  removeLayer(id, false);
  layer.addTo(S.map);
  if (opacity && layer.setOpacity) layer.setOpacity(Number($('#opacity').value) / 100);
  S.layers.set(id, {layer, label, color, legend, opacity});
  renderChips();
}
function removeLayer(id, render = true) {
  const it = S.layers.get(id);
  if (it) { S.map.removeLayer(it.layer); S.layers.delete(id); }
  if (!render) return;  // internal replace: keep reloader & compare state
  S.reloaders.delete(id);
  if (id === 'rasterB' && it) { setCompare(false); $('#compareYearWrap').classList.add('hidden'); }
  if (id === 'rasterA' && S.layers.has('rasterB')) removeLayer('rasterB');
  renderChips();
}
function renderChips() {
  const box = $('#activeLayers');
  box.innerHTML = '';
  for (const [id, it] of S.layers) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = `<i style="background:${it.color}"></i><span>${esc(it.label)}</span><button type="button" title="Hapus lapisan">✕</button>`;
    $('button', chip).onclick = () => { removeLayer(id); syncToggles(); };
    box.appendChild(chip);
  }
  const legends = [...S.layers.values()].filter((l) => l.legend).map((l) => l.legend);
  $('#legend').innerHTML = legends.slice(-2).join('<hr style="border:0;border-top:1px solid #e2e9e1;margin:10px 0">');
  $('#legend').classList.toggle('hidden', legends.length === 0);
}
function syncToggles() {
  $('#lcToggle').checked = S.layers.has('landcover');
  $('#habitatToggle').checked = S.layers.has('habitat');
  $$('.sp[data-id]').forEach((el) => el.classList.toggle('on', S.layers.has('sp:' + el.dataset.id)));
  $$('.sp input[type=checkbox]').forEach((i) => { i.checked = S.layers.has('sp:' + i.dataset.id); });
  for (const k of ['kawasan', 'tegakan', 'das', 'sungai', 'kabupaten', 'tanah']) { const t = $(`#${k}Toggle`); if (t) t.checked = S.layers.has('vec:' + k); }
}

function legendGradient(title, palette, min, max, low = '', high = '') {
  return `<h5>${esc(title)}</h5><div class="bar" style="background:${gradient(palette)}"></div>
    <div class="ends"><span>${esc(min)}${low ? ' · ' + esc(low) : ''}</span><span>${high ? esc(high) + ' · ' : ''}${esc(max)}</span></div>`;
}
function legendCats(title, items) {
  return `<h5>${esc(title)}</h5><div class="cats">${items.map((i) => `<span><i style="background:${i.color}"></i>${esc(i.label)}</span>`).join('')}</div>`;
}

/* --------------------------------------------------- compare (swipe) */
function setCompare(on, toggleUi = true) {
  S.compare = on;
  $('#swipe').classList.toggle('hidden', !on);
  $('#swipeLabels').classList.toggle('hidden', !on);
  if (toggleUi) $('#compareToggle').checked = on;
  updateClip();
}
function updateClip() {
  if (!S.map) return;
  const a = S.map.getPane('rasterA'), b = S.map.getPane('rasterB');
  if (!S.compare) { a.style.clip = ''; b.style.clip = ''; return; }
  const nw = S.map.containerPointToLayerPoint([0, 0]);
  const se = S.map.containerPointToLayerPoint(S.map.getSize());
  const x = nw.x + S.map.getSize().x * Number($('#swipe').value) / 100;
  a.style.clip = `rect(${nw.y}px, ${x}px, ${se.y}px, ${nw.x}px)`;
  b.style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
}

/* ------------------------------------------------------------- area */
const AREA_PROV = {all: null, jabar: 'Jawa Barat', banten: 'Banten', jakarta: 'DKI Jakarta'};
const inArea = (f) => !AREA_PROV[S.area] || !f.properties.provinsi || f.properties.provinsi === AREA_PROV[S.area];

async function loadBoundary() {
  if (!S.map) return;
  try {
    // Built-in file (works without Earth Engine); fall back to Earth Engine.
    let gj = null;
    try {
      const d = await getVector('batas');
      if (d.available) gj = {type: 'FeatureCollection', features: d.geojson.features
        .filter((f) => !AREA_PROV[S.area] || f.properties.name === AREA_PROV[S.area])};
    } catch { gj = null; }
    if (!gj && S.ready) gj = await api(`/api/boundary?area=${S.area}`);
    if (!gj) return;
    if (S.boundary) S.map.removeLayer(S.boundary);
    S.boundary = L.geoJSON(gj, {pane: 'boundary', interactive: false,
      style: {color: '#0b2f29', weight: 2, opacity: .9, fill: false, dashArray: '6 5'}}).addTo(S.map);
    if (S.boundary.getBounds().isValid()) fitArea(S.boundary.getBounds());
  } catch (err) { toast('Batas wilayah tidak dimuat', ' ' + err.message, 'err'); }
}

function setArea(area) {
  S.area = area;
  $$('#areaSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.area === area); b.setAttribute('aria-checked', b.dataset.area === area); });
  $('#areaSelect').value = area;
  $('#kpiArea').textContent = S.status?.areas?.[area] || area;
  if (S.map) fitArea(L.latLngBounds(BOUNDS[area]));
  loadBoundary();
  for (const fn of [...S.reloaders.values()]) fn();  // re-run active Earth Engine layers for the new area
  S.gbif = {};
  for (const id of [...S.layers.keys()]) if (id.startsWith('sp:')) removeLayer(id);
  if (S.layers.has('vec:kawasan')) showVector('kawasan', false);
  if (S.vectors.kawasan) renderVector('kawasan');
  if (S.layers.has('vec:kabupaten')) showVector('kabupaten', false);
  if (S.vectors.kabupaten) renderKab();
  if (S.module === 'bio') loadBio();
  loadFaunaKpi();
}

/* -------------------------------------------------------- modules */
function setModule(name) {
  S.module = name;
  $$('.rail-btn').forEach((b) => b.classList.toggle('on', b.dataset.module === name));
  $$('.module').forEach((m) => m.classList.toggle('on', m.dataset.module === name));
  $('#panel').scrollTop = 0;
  $('#panel').classList.remove('collapsed');
  if (isMobile() && S.sheet === 'peek') setSheet('half');
  if (name === 'bio') { loadVector('kawasan'); loadKab(); loadBio(); }
  if (name === 'land') { renderIndexMethod(); renderEnvInfo(); renderCdseCard('#cdseIndexCard', 'index'); }
  if (name === 'water') { loadHydro(); renderWaterInfo(); renderCdseCard('#cdseWaterCard', 'water'); }
  if (name === 'news' && typeof loadNews === 'function') loadNews();
}

/* ======================================================= OVERVIEW */
function renderSources() {
  const cat = Object.fromEntries((S.catalog || []).map((c) => [c.kind, c]));
  const vec = (kind, label) => [cat[kind]?.available ? 'ok' : 'off', label,
    cat[kind] ? (cat[kind].available ? cat[kind].source : `Belum tersedia · ${cat[kind].source}`) : '…'];
  const items = [
    [S.ready ? 'ok' : 'off', 'Google Earth Engine', S.ready ? 'Terhubung. Sentinel-2, CHIRPS, MODIS, WorldCover, SRTM siap.' : (S.status?.error || 'Belum terhubung.')],
    [S.gbif.animals ? 'ok' : '', 'GBIF · catatan biodiversitas', S.gbif.animals ? `Diperbarui ${new Date(S.gbif.animals.fetched * 1000).toLocaleDateString('id-ID')}` : 'Dimuat saat modul Biodiversitas dibuka.'],
    vec('kawasan', 'Kawasan hutan'), vec('das', 'Daerah Aliran Sungai'), vec('sungai', 'Sungai'), vec('tanah', 'Jenis tanah'), vec('kabupaten', 'Batas kabupaten/kota'),
    ...(cat.tegakan?.available ? [vec('tegakan', 'Jenis tegakan')] : []),
    [S.status?.cdse?.instance ? 'ok' : 'off', 'Copernicus Data Space · Sentinel-2 realtime', S.status?.cdse?.instance ? 'Aktif: peta indeks & kualitas air 10 m terbaru.' : 'Belum dikonfigurasi (CDSE_INSTANCE_ID).'],
    ['ok', 'NASA GIBS / FIRMS', 'Titik panas, citra harian, aerosol, NO₂, SO₂, CO, hujan (tanpa kunci).'],
    ['ok', 'Open-Meteo', 'Kualitas udara (CAMS) & cuaca terkini per kab/kota (tanpa kunci, nonkomersial).'],
  ];
  $('#sourceList').innerHTML = items.map(([c, t, d]) => `<li class="${c}"><i></i><div><b>${esc(t)}</b><small>${esc(d)}</small></div></li>`).join('');
}
async function loadFaunaKpi() {
  try {
    const d = await getGbif('animals');
    $('#kpiFauna').textContent = fmtInt(d.species.reduce((a, s) => a + s.records, 0));
  } catch { $('#kpiFauna').textContent = '—'; }
  renderSources();
}

/* ============================================ VECTORS (bawaan, hanya-baca) */
async function getVector(kind) {
  if (!S.vectors[kind]) S.vectors[kind] = await api(`/api/layers/${kind}`);
  return S.vectors[kind];
}

async function loadVector(kind) {
  const box = $(`#${kind}Box`);
  if (!S.vectors[kind]) box.innerHTML = '<div class="skeleton"></div>';
  try { await getVector(kind); }
  catch (err) { box.innerHTML = `<p class="muted">Gagal memuat: ${esc(err.message)}</p>`; return; }
  renderVector(kind);
}

/** Summary per class for features in the selected area. */
function summarize(d) {
  const rows = new Map();
  for (const f of d.geojson.features) {
    if (!inArea(f)) continue;
    const p = f.properties;
    const r = rows.get(p._class) || {label: p._class, color: p._color, size: 0, n: 0, sub: new Map()};
    r.size += p._size || 0; r.n += 1;
    if (p.jenis) r.sub.set(p.jenis, (r.sub.get(p.jenis) || 0) + (p._size || 0));
    rows.set(p._class, r);
  }
  return [...rows.values()].sort((a, b) => b.size - a.size);
}

function renderVector(kind) {
  const d = S.vectors[kind];
  const box = $(`#${kind}Box`);
  // Layers without data are simply not shown (no empty "data belum tersedia" card).
  box.classList.toggle('hidden', !d.available);
  if (!d.available) { box.innerHTML = ''; return; }
  const rows = summarize(d);
  const total = rows.reduce((a, r) => a + r.size, 0);
  const n = rows.reduce((a, r) => a + r.n, 0);
  const detail = rows.some((r) => r.sub.size > 1)
    ? `<details class="method"><summary>Rincian ${kind === 'tanah' ? 'jenis tanah' : 'jenis kawasan'}</summary>${rows.map((r) => r.sub.size
      ? `<p><b>${esc(r.label)}</b><br>${[...r.sub].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)}: ${fmtInt(v)} ${d.unit}`).join('<br>')}</p>` : '').join('')}</details>`
    : '';
  box.innerHTML = `<div class="row-between"><div><h4>${esc(d.title)}</h4><p class="muted">${n} poligon · ${fmtInt(total)} ${d.unit} · ${esc(S.status?.areas?.[S.area] || '')}</p></div>
      <label class="switch"><input type="checkbox" id="${kind}Toggle"><i></i></label></div>
    <div class="dist">${rows.map((r) => `<i title="${esc(r.label)}" style="width:${total ? r.size / total * 100 : 0}%;background:${r.color}"></i>`).join('')}</div>
    <div class="dist-legend">${rows.map((r) => `<div><i style="background:${r.color}"></i>${esc(r.label)}<b>${fmtInt(r.size)} ${d.unit}</b><small>${pct(total ? r.size / total : null)}</small></div>`).join('')}</div>
    ${detail}
    <p class="fine">Sumber: ${esc(d.source)}</p>`;
  const t = $(`#${kind}Toggle`, box);
  t.checked = S.layers.has('vec:' + kind);
  t.onchange = () => t.checked ? showVector(kind) : removeLayer('vec:' + kind);
}

function popupHtml(d, p) {
  const rows = Object.entries(d.popup || {}).filter(([k]) => p[k] !== null && p[k] !== undefined && p[k] !== '')
    .map(([k, label]) => `<tr><td>${esc(label)}</td><td>${esc(typeof p[k] === 'number' ? p[k].toLocaleString('id-ID', {maximumFractionDigits: 1}) : String(p[k]).replace(/ \d\d:\d\d:\d\d.*$/, ''))}</td></tr>`).join('');
  const size = p._size ? `<tr><td>${d.geometry === 'line' ? 'Panjang' : 'Luas'} di peta</td><td>${fmt(p._size, 1)} ${d.unit}</td></tr>` : '';
  return `<div class="pt"><h4>${esc(p._name || p._class)}</h4>${p._name ? `<div class="coord">${esc(p._class)}</div>` : ''}<table>${rows}${size}</table></div>`;
}

const VEC_STYLE = {
  kawasan: (f) => ({color: f.properties._color, weight: 1, fillColor: f.properties._color, fillOpacity: .5}),
  tegakan: (f) => ({color: f.properties._color, weight: 1, fillColor: f.properties._color, fillOpacity: .5}),
  tanah: (f) => ({color: f.properties._color, weight: .6, fillColor: f.properties._color, fillOpacity: .6}),
  das: (f) => ({color: f.properties._color, weight: f.properties._class === 'DAS prioritas' ? 2 : 1,
    fillColor: f.properties._color, fillOpacity: f.properties._class === 'DAS prioritas' ? .12 : .04}),
  sungai: () => ({color: '#0284c7', weight: 1.6, opacity: .9}),
  kabupaten: (f) => ({color: '#334155', weight: 1.2, fillColor: kabColor(f.properties.kws_persen), fillOpacity: .55}),
};

function showVector(kind, fly = true) {
  const d = S.vectors[kind];
  if (!d?.available) return;
  const layer = L.geoJSON(d.geojson, {
    pane: 'vectors',
    filter: inArea,
    style: VEC_STYLE[kind],
    onEachFeature: (f, l) => {
      l.bindPopup(popupHtml(d, f.properties));
      if (f.properties._name && kind !== 'sungai') l.bindTooltip(esc(f.properties._name), {sticky: true, direction: 'top'});
      l.on('click', () => { S.skipClick = true; });
    },
  });
  const legend = kind === 'kabupaten'
    ? legendGradient('Porsi kawasan hutan per kab/kota', KAB_RAMP.map((c) => c.slice(1)), '0%', '≥60%', '', '')
    : kind === 'sungai'
    ? `<h5>${esc(d.title)}</h5><div class="cats"><span><i style="background:#0284c7;height:3px"></i>Garis sungai</span></div>`
    : legendCats(d.title, summarize(d));
  setLayer('vec:' + kind, layer, {label: d.title, color: d.legend[0]?.color, opacity: false, legend});
  if (fly && kind === 'kawasan' && layer.getBounds().isValid()) S.map.flyToBounds(layer.getBounds(), {padding: [20, 20], duration: .8});
}

const KAB_RAMP = ['#f7fcf5', '#c7e9c0', '#74c476', '#31a354', '#006d2c'];
const kabColor = (pctv) => KAB_RAMP[Math.min(4, Math.floor((pctv || 0) / 15))];

async function loadKab() {
  const box = $('#kabBox');
  if (!S.vectors.kabupaten) box.innerHTML = '<div class="skeleton"></div>';
  try { await getVector('kabupaten'); } catch (err) { box.innerHTML = `<p class="muted">Gagal memuat: ${esc(err.message)}</p>`; return; }
  renderKab();
}

function renderKab() {
  const d = S.vectors.kabupaten;
  const box = $('#kabBox');
  if (!d.available) { box.innerHTML = '<h4>Kabupaten / kota</h4><p class="muted">Data belum tersedia.</p>'; return; }
  const rows = d.geojson.features.filter(inArea).map((f) => f.properties)
    .sort((a, b) => (b.kws_total_km2 || 0) - (a.kws_total_km2 || 0));
  const max = Math.max(1, ...rows.map((r) => r.kws_total_km2 || 0));
  const seg = (r, key, color) => `<i style="width:${(r[key] || 0) / max * 100}%;background:${color}" title="${esc(key)}"></i>`;
  box.innerHTML = `<div class="row-between"><div><h4>Kawasan hutan per kabupaten/kota</h4>
      <p class="muted">${rows.length} kab/kota · peta diwarnai menurut porsi kawasan hutan</p></div>
      <label class="switch"><input type="checkbox" id="kabupatenToggle"><i></i></label></div>
    <div class="kab-list">${rows.map((r) => `<button type="button" class="kab-row" data-kab="${esc(r.nama)}">
      <span class="kab-name">${esc(r.nama)}<small>${esc(r.provinsi)} · ${fmt(r.kws_persen, 1)}%</small></span>
      <span class="kab-bar dist">${seg(r, 'kws_konservasi_km2', '#1e3a8a')}${seg(r, 'kws_lindung_km2', '#0d9488')}${seg(r, 'kws_hpt_km2', '#a3e635')}${seg(r, 'kws_hp_km2', '#65a30d')}</span>
      <b>${fmtInt(r.kws_total_km2)} km²</b></button>`).join('')}</div>
    <p class="fine">Kawasan konservasi laut di luar daratan kab/kota tidak terhitung. Klik nama untuk memperbesar peta.</p>`;
  const t = $('#kabupatenToggle', box);
  t.checked = S.layers.has('vec:kabupaten');
  t.onchange = () => t.checked ? showVector('kabupaten') : removeLayer('vec:kabupaten');
  $$('.kab-row', box).forEach((b) => b.onclick = () => {
    if (!S.layers.has('vec:kabupaten')) { showVector('kabupaten', false); t.checked = true; }
    const f = d.geojson.features.find((x) => x.properties.nama === b.dataset.kab);
    const bounds = L.geoJSON(f).getBounds();
    S.map.flyToBounds(bounds, {padding: [30, 30], duration: .8});
    S.skipClick = true;
    setTimeout(() => { S.skipClick = false; L.popup().setLatLng(bounds.getCenter()).setContent(popupHtml(d, f.properties)).openOn(S.map); }, 900);
  });
}

async function loadHydro() {
  for (const kind of ['das', 'sungai']) {
    const info = $(`#${kind}Info`);
    const t = $(`#${kind}Toggle`);
    try {
      const d = await getVector(kind);
      if (!d.available) { info.textContent = 'Data belum tersedia'; t.disabled = true; continue; }
      info.textContent = kind === 'das' ? `${d.features} DAS · ${fmtInt(d.total)} km² · KLHK` : `${d.features} ruas · ${fmtInt(d.total)} km · BIG 1:250K`;
      t.checked = S.layers.has('vec:' + kind);
      t.onchange = () => t.checked ? showVector(kind) : removeLayer('vec:' + kind);
      if (kind === 'das') {
        const pri = d.geojson.features.filter((f) => f.properties._class === 'DAS prioritas')
          .sort((a, b) => b.properties._size - a.properties._size);
        $('#dasPriority').innerHTML = pri.length
          ? `<p class="muted"><b style="color:#dc2626">DAS prioritas</b> di wilayah pantauan: ${pri.map((f) => `${esc(f.properties.nama_das)} (${fmtInt(f.properties._size)} km²)`).join(', ')}.</p>` : '';
      }
    } catch (err) { info.textContent = 'Gagal memuat: ' + err.message; }
  }
}

/* ===================================================== BIODIVERSITY */
async function getGbif(group) {
  if (!S.gbif[group]) S.gbif[group] = await api(`/api/biodiversity/${group}?area=${S.area}`);
  return S.gbif[group];
}

async function loadBio() {
  loadVector('tegakan');
  for (const group of ['plants', 'animals']) {
    const box = $(group === 'plants' ? '#plantList' : '#animalList');
    if (box.dataset.area === S.area && box.dataset.loaded) continue;
    box.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    try {
      const d = await getGbif(group);
      box.dataset.area = S.area; box.dataset.loaded = '1';
      box.classList.toggle('compact', group === 'plants');
      box.innerHTML = d.species.map((sp) => speciesCard(sp, group)).join('');
      $$('input[type=checkbox]', box).forEach((i) => {
        i.onchange = async () => {
          const sp = d.species.find((s) => s.id === i.dataset.id);
          if (i.checked && sp.zone) await getVector('kawasan').catch(() => null);
          i.checked ? showSpecies(sp) : removeLayer('sp:' + sp.id);
          syncToggles();
        };
      });
      if (d.stale) toast('GBIF tidak dapat dihubungi', ' Menampilkan data simpanan terakhir.');
    } catch (err) {
      box.innerHTML = `<p class="muted">Data GBIF belum dapat dimuat: ${esc(err.message)}</p>`;
    }
  }
  renderSources();
}

function speciesCard(sp, group) {
  const code = sp.iucn?.code;
  const iucn = code ? `<span class="iucn ${code}" title="IUCN ${esc(sp.iucn.scope || '')}">${code} · ${IUCN_ID[code] || ''}</span>` : '';
  const years = sp.first_year ? `${sp.first_year}–${sp.last_year}` : '—';
  if (group === 'plants') {
    return `<div class="sp" data-id="${sp.id}" style="--c:${sp.color}">
      <div class="sp-head"><span class="sp-dot"></span><div class="sp-title"><b>${esc(sp.name)}</b><i>${esc(sp.scientific)} · ${esc(sp.forest)}</i></div></div>
      <div class="sp-meta"><span>${fmtInt(sp.records)} catatan</span></div>
      <label class="switch"><input type="checkbox" data-id="${sp.id}" aria-label="Tampilkan ${esc(sp.name)}"><i></i></label></div>`;
  }
  return `<div class="sp" data-id="${sp.id}" style="--c:${sp.color}">
    <div class="sp-head"><div class="sp-ico">${sp.icon}</div><div class="sp-title"><b>${esc(sp.name)}</b><i>${esc(sp.scientific)}</i></div>
      <label class="switch"><input type="checkbox" data-id="${sp.id}" aria-label="Tampilkan habitat ${esc(sp.name)}"><i></i></label></div>
    <p>${esc(sp.habitat)}</p>
    <div class="sp-meta">${iucn}<span>${fmtInt(sp.records)} catatan</span><span>${fmtInt(sp.records_since_2015)} sejak 2015</span><span>${years}</span><span>${sp.grid.features.length} sel</span></div>
    ${sp.note ? `<small class="fine">${esc(sp.note)}</small>` : ''}
    <a href="${sp.gbif_url}" target="_blank" rel="noopener">Lihat di GBIF ↗</a></div>`;
}

function showSpecies(sp) {
  const max = Math.max(1, ...sp.grid.features.map((f) => f.properties.count));
  const layer = L.geoJSON(sp.grid, {
    pane: 'vectors',
    style: (f) => ({color: sp.color, weight: 1, fillColor: sp.color, fillOpacity: .25 + .55 * Math.sqrt(f.properties.count / max)}),
    onEachFeature: (f, l) => {
      l.bindPopup(`<div class="pt"><h4>${esc(sp.name)}</h4><div class="coord">Sel ±${Math.round(sp.grid_deg * 111)} km</div>
        <table><tr><td>Catatan</td><td>${f.properties.count}</td></tr><tr><td>Tahun terakhir</td><td>${f.properties.last_year ?? '—'}</td></tr></table></div>`);
      l.on('click', () => { S.skipClick = true; });
    },
  });
  let legend = `<h5>${esc(sp.name)} (GBIF)</h5><div class="ends"><span>Sel ±${Math.round(sp.grid_deg * 111)} km</span><span>warna pekat = banyak catatan</span></div>`;
  let group = layer;
  const zone = sp.zone && zoneLayer(sp);
  if (zone) {
    group = L.featureGroup([zone, layer]);
    legend += `<div class="cats" style="margin-top:8px"><span><i style="background:${sp.color};outline:2px solid ${sp.color};opacity:.5"></i>${esc(sp.zone.label)} (habitat)</span></div>`;
  }
  setLayer('sp:' + sp.id, group, {label: `${sp.name} · ${sp.records} catatan`, color: sp.color, opacity: false, legend});
  if (zone && zone.getBounds().isValid()) S.map.flyToBounds(zone.getBounds(), {padding: [30, 30], duration: .8});
}

/** Habitat polygon(s) for species tied to one protected area (e.g. badak jawa → TN Ujung Kulon). */
function zoneLayer(sp) {
  const kw = S.vectors.kawasan;
  if (!kw?.available) return null;
  const z = sp.zone;
  const feats = kw.geojson.features.filter((f) => {
    const p = f.properties;
    if (p.provinsi !== z.provinsi || !String(p.jenis || '').startsWith(z.jenis) || p.sk_penetapan !== z.sk) return false;
    return L.geoJSON(f).getBounds().getCenter().lng <= z.max_lon;
  });
  if (!feats.length) return null;
  return L.geoJSON({type: 'FeatureCollection', features: feats}, {
    pane: 'vectors',
    style: {color: sp.color, weight: 2.5, dashArray: '6 4', fillColor: sp.color, fillOpacity: .12},
    onEachFeature: (f, l) => {
      l.bindPopup(`<div class="pt"><h4>${esc(z.label)}</h4><div class="coord">Habitat ${esc(sp.name)}</div>
        <table><tr><td>Jenis</td><td>${esc(f.properties.jenis)}</td></tr><tr><td>SK</td><td>${esc(f.properties.sk_penetapan)}</td></tr>
        <tr><td>Luas</td><td>${fmtInt(f.properties._size)} km²</td></tr></table></div>`);
      l.on('click', () => { S.skipClick = true; });
    },
  });
}

/* ================================================= EARTH ENGINE layers */
async function eeTileLayer(id, path, {pane = 'rasterA', label, color, legend}) {
  busy(true);
  try {
    const d = await api(path);
    // Static build: pre-rendered overlay image (snapshot). Server: live Earth Engine tiles.
    let layer;
    if (d.images || d.image) {
      const parts = (d.images || [{image: d.image, bounds: d.bounds}]).map((t) =>
        L.imageOverlay(t.image, t.bounds, {pane, attribution: 'Google Earth Engine (snapshot)', interactive: false}));
      layer = L.layerGroup(parts);
      layer.setOpacity = (o) => parts.forEach((p) => p.setOpacity(o));  // used by the opacity slider
    } else {
      layer = L.tileLayer(d.tiles, {pane, maxZoom: 19, attribution: 'Google Earth Engine'});
    }
    let errors = 0;
    layer.on('tileerror', () => { if (++errors === 3) toast('Sebagian tile gagal dimuat', ' Coba muat ulang lapisan.'); });
    setLayer(id, layer, {label, color, legend});
    return d;
  } finally { busy(false); }
}

async function toggleLandcover(on, id = 'landcover', habitat = false) {
  if (!on) { removeLayer(id); return; }
  if (needEE()) { syncToggles(); return; }
  const wc = S.status.worldcover;
  const run = () => eeTileLayer(id, `/api/env/map?layer=landcover&year=2021&mask=${habitat ? 'trees' : 'region'}&area=${S.area}`, {
    pane: 'rasterA', label: habitat ? 'Habitat hutan (pohon + mangrove)' : 'Tutupan lahan WorldCover 2021', color: '#006400',
    legend: legendCats(habitat ? 'Tutupan pohon & mangrove 2021' : 'WorldCover 2021', habitat ? wc.filter((c) => [10, 95].includes(c.code)) : wc.filter((c) => c.code !== 70 && c.code !== 100)),
  }).catch((err) => { toast('Lapisan gagal dimuat', ' ' + err.message, 'err'); removeLayer(id); syncToggles(); });
  await run();
  S.reloaders.set(id, run);
}

/* ------------------------------------------------------------ INDEX */
function renderIndexCards() {
  const idx = S.status?.indices || {};
  $('#indexCards').innerHTML = Object.entries(idx).map(([k, v]) => `<button type="button" class="idx ${k === S.index ? 'on' : ''}" data-index="${k}">
    <b>${esc(v.label)}</b><div class="ramp" style="background:${gradient(v.palette)}"></div><small>${esc(v.meaning)}</small></button>`).join('');
  $$('.idx').forEach((b) => b.onclick = () => {
    S.index = b.dataset.index;
    $$('.idx').forEach((x) => x.classList.toggle('on', x === b));
    renderIndexMethod();
    $('#idxStats').innerHTML = '';
    $('#trendChart').innerHTML = '<p class="muted">Klik “Hitung tren” untuk indeks ini.</p>';
    $('#trendTitle').textContent = `Tren tahunan ${S.status.indices[S.index].label}`;
    renderCdseCard('#cdseIndexCard', 'index');
    if (S.layers.has('rasterA')) loadIndex();
  });
}
function renderIndexMethod() {
  const v = S.status?.indices?.[S.index];
  if (!v) return;
  $('#idxMethod').innerHTML = `<p><b>${esc(v.label)}</b>: ${esc(v.name)}.<br>Rumus: <code>${esc(v.formula)}</code><br>${esc(v.meaning)}</p>
    <p>Sumber: Sentinel-2 SR Harmonized. Piksel awan/bayangan dibuang dengan SCL (dipertahankan kelas 4, 5, 6), lalu dibuat komposit median reflektans per periode. Tahun berjalan hanya memakai bulan yang sudah selesai. Statistik regional disampel pada 250 m. Area tanpa piksel valid ditampilkan kosong, bukan nol.</p>
    <p>MSARVI mengikuti Huete &amp; Liu (1994): RB = Merah − γ(Biru − Merah), γ = 1. NDWI memakai versi McFeeters (Hijau, NIR) untuk badan air; NDBI memakai SWIR1 B11 (20 m).</p>`;
}
const idxParams = (year) => `index=${S.index}&year=${year}&month=${$('#idxMonth').value}&mask=${S.mask}&area=${S.area}`;

async function loadIndex() {
  if (needEE()) return;
  const v = S.status.indices[S.index];
  const yA = Number($('#idxYear').value), yB = Number($('#idxYearB').value);
  const m = Number($('#idxMonth').value);
  const per = m ? ' ' + MONTHS[m] : '';
  const legend = legendGradient(v.label, v.palette, v.min, v.max, v.low, v.high);
  const btn = $('#idxLoad'); btn.disabled = true;
  const cmp = $('#compareToggle').checked;
  if (!cmp && S.layers.has('rasterB')) removeLayer('rasterB');
  const run = async () => {
    S.compare = cmp;
    const jobs = [eeTileLayer('rasterA', `/api/map?${idxParams(yA)}`, {pane: 'rasterA', label: `${v.label} ${yA}${per}`, color: '#' + v.palette[4], legend})];
    if (cmp) jobs.push(eeTileLayer('rasterB', `/api/map?${idxParams(yB)}`, {pane: 'rasterB', label: `${v.label} ${yB}${per}`, color: '#' + v.palette[2]}));
    const [a] = await Promise.all(jobs);
    if (cmp) { setCompare(true); $('#swipeA').textContent = `◀ ${yA}`; $('#swipeB').textContent = `${yB} ▶`; }
    if (a.partial_year) toast('Tahun berjalan', ` Komposit ${yA} hanya sampai ${a.end_inclusive}.`);
  };
  try {
    await run();
    S.reloaders.set('rasterA', run);
    loadIndexStats(yA, cmp ? yB : null);
  } catch (err) { toast('Peta indeks gagal dimuat', ' ' + err.message, 'err'); }
  finally { btn.disabled = false; }
}

async function loadIndexStats(yA, yB) {
  const box = $('#idxStats');
  box.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const [a, b] = await Promise.all([api(`/api/statistics?${idxParams(yA)}`), yB ? api(`/api/statistics?${idxParams(yB)}`) : null]);
    const card = (s, y) => `<div class="stat"><span>Rerata ${S.status.indices[S.index].label} · ${y}</span><strong>${fmt(s.mean)}</strong>
      <small>P10 ${fmt(s.p10, 2)} · P90 ${fmt(s.p90, 2)} · ${fmtInt(s.valid_samples)} sampel</small></div>`;
    let html = card(a, yA) + (b ? card(b, yB) : `<div class="stat"><span>Periode</span><strong style="font-size:1rem">${a.start} — ${a.end_inclusive}</strong><small>${a.mask === 'trees' ? 'Tutupan pohon' : 'Seluruh wilayah'}</small></div>`);
    if (b && a.mean !== null && b.mean !== null) {
      const d = b.mean - a.mean;
      html += `<div class="stat delta"><span>Selisih rerata (${yB} − ${yA})</span><strong>${d > 0 ? '+' : ''}${fmt(d)}</strong><small>Indikasi perubahan, perlu verifikasi musim & lapangan.</small></div>`;
    }
    box.innerHTML = html;
  } catch (err) { box.innerHTML = `<p class="muted">Statistik gagal: ${esc(err.message)}</p>`; }
}

async function loadTrend() {
  if (needEE()) return;
  const v = S.status.indices[S.index];
  const btn = $('#trendBtn'); btn.disabled = true;
  const chart = $('#trendChart');
  const m = Number($('#idxMonth').value);
  const now = new Date();
  const years = [];
  for (let y = S.status.first_year; y <= S.currentYear; y++) {
    if (y === S.currentYear && (m ? m >= now.getMonth() + 1 : now.getMonth() === 0)) continue;
    years.push(y);
  }
  const pts = [];
  try {
    for (const y of years) {
      chart.innerHTML = `<p class="muted">Menghitung ${v.label} ${y}… (${pts.length + 1}/${years.length})</p>`;
      try { const d = await api(`/api/statistics?${idxParams(y)}`); pts.push({x: y, y: d.mean, p10: d.p10, p90: d.p90}); }
      catch { pts.push({x: y, y: null}); }
    }
    chart.innerHTML = lineChart(pts, '#' + v.palette[4]);
  } finally { btn.disabled = false; }
}

function lineChart(pts, color) {
  const ok = pts.filter((p) => p.y !== null);
  if (!ok.length) return '<p class="muted">Belum ada nilai valid.</p>';
  const W = 400, H = 180, P = {l: 40, r: 12, t: 14, b: 26};
  const lo = Math.min(...ok.map((p) => p.p10 ?? p.y)), hi = Math.max(...ok.map((p) => p.p90 ?? p.y));
  const pad = (hi - lo) * .1 || .05, y0 = lo - pad, y1 = hi + pad;
  const X = (i) => P.l + (pts.length === 1 ? (W - P.l - P.r) / 2 : i * (W - P.l - P.r) / (pts.length - 1));
  const Y = (v) => P.t + (1 - (v - y0) / (y1 - y0)) * (H - P.t - P.b);
  const ticks = [0, .5, 1].map((t) => y0 + t * (y1 - y0));
  const band = ok.every((p) => p.p10 !== undefined && p.p10 !== null)
    ? `<path d="${pts.map((p, i) => p.y === null ? '' : `${i && pts[i - 1].y !== null ? 'L' : 'M'}${X(i)},${Y(p.p90)}`).join('')} ${[...pts].reverse().map((p, j) => { const i = pts.length - 1 - j; return p.y === null ? '' : `L${X(i)},${Y(p.p10)}`; }).join('')}Z" fill="${color}" opacity=".12"/>` : '';
  let path = '';
  pts.forEach((p, i) => { if (p.y !== null) path += `${path && pts[i - 1]?.y !== null ? 'L' : 'M'}${X(i)},${Y(p.y)}`; });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafik tren">
    ${ticks.map((t) => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="#e2e9e1"/><text x="${P.l - 6}" y="${Y(t) + 4}" font-size="10" text-anchor="end" fill="#7a8f88">${t.toFixed(2)}</text>`).join('')}
    ${band}<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>
    ${pts.map((p, i) => `<text x="${X(i)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="#7a8f88">${p.x}</text>` +
      (p.y === null ? '' : `<circle cx="${X(i)}" cy="${Y(p.y)}" r="4" fill="#fff" stroke="${color}" stroke-width="2"><title>${p.x}: ${fmt(p.y)}</title></circle>`)).join('')}
  </svg><p class="fine">Garis = rerata; pita = rentang P10–P90. Tahun berjalan bisa belum lengkap.</p>`;
}

/* -------------------------------------------------------------- ENV */
const ENV_TEXT = {
  erosion: {desc: 'Perkiraan laju erosi tanah (ton/ha/tahun) dengan model RUSLE. Merah = bahaya erosi tinggi: lereng curam, tanah peka, vegetasi jarang, hujan deras.',
    year: 'Tahun', method: '<code>A = R × K × LS × C × P</code>. R = erosivitas hujan (Lenvain, CHIRPS). K = erodibilitas tanah: dari peta tanah semi detail BBSDLP bila tersedia, selain itu dari tekstur & karbon organik OpenLandMap (Williams/EPIC). LS = panjang & kemiringan lereng dari MERIT Hydro (Moore & Burch, panjang aliran dibatasi ±300 m). C = penutupan vegetasi dari NDVI MODIS (van der Knijff). P = 1 (tidak ada data tindakan konservasi, sehingga hasil cenderung lebih tinggi di lahan berteras). Permukiman & badan air tidak dihitung. Kelas bahaya: sangat ringan < 15, ringan 15–60, sedang 60–180, berat 180–480, sangat berat > 480 ton/ha/tahun. Hasil bersifat indikatif, belum dikalibrasi pengukuran lapangan.'},
  erosivity: {desc: 'Kemampuan hujan menimbulkan erosi (faktor R). Tinggi = hujan deras & sering, potensi erosi besar terutama di lereng terbuka.',
    year: 'Tahun', method: 'R bulanan dihitung dengan rumus Lenvain yang lazim dipakai di Indonesia: <code>R = 2,21 × P<sup>1,36</sup></code>, P = curah hujan bulanan (cm) dari CHIRPS harian (~5,5 km). R tahunan = jumlah R bulanan. Hanya bulan yang lengkap di CHIRPS dipakai. Kelas (rendah < 1.500, sedang < 2.500, tinggi < 3.500, sangat tinggi) bersifat relatif untuk perbandingan wilayah.'},
  degradation: {desc: 'Tren kehijauan jangka panjang. Penurunan NDVI konsisten menjadi indikasi degradasi lahan, kenaikan menjadi indikasi pemulihan.',
    year: 'Akhir periode tren', method: 'Rerata NDVI tahunan MODIS MOD13Q1 (250 m, piksel kualitas baik) sejak 2001 hingga tahun akhir, lalu kemiringan regresi linier per piksel (ΔNDVI/tahun). Ambang ±0,003/tahun (≈ ±0,06 dalam 20 tahun). Ini indikasi, bukan peta degradasi resmi; verifikasi dengan citra resolusi tinggi & lapangan.'},
  rainfall: {desc: 'Total curah hujan dalam periode (CHIRPS). Dasar perhitungan erosivitas.',
    year: 'Tahun', method: 'Jumlah curah hujan harian CHIRPS (UCSB-CHG/CHIRPS/DAILY) pada bulan-bulan lengkap tahun terpilih.'},
};
function renderEnvInfo() {
  const t = ENV_TEXT[S.env];
  $('#envDesc').textContent = t.desc;
  $('#envMethod').innerHTML = `<p>${t.method}</p>`;
  $('#envYearLabel').firstChild.textContent = t.year;
  const max = S.env === 'degradation' ? S.currentYear - 1 : S.currentYear;
  const cur = Math.min(Number($('#envYear').value) || max, max);
  fillYears($('#envYear'), S.env === 'degradation' ? 2006 : (S.status?.env_first_year || 2001), max, S.env === 'degradation' ? max : Math.min(cur, S.currentYear - 1));
  if (SNAP()) setOptions($('#envYear'), [SNAP().env_year]);
}

async function loadEnv() {
  if (needEE()) return;
  const layer = S.env, spec = S.status.env_layers[layer];
  const year = Number($('#envYear').value), mask = $('#envMask').value;
  const q = `layer=${layer}&year=${year}&mask=${mask}&area=${S.area}`;
  const legend = spec.classes
    ? legendGradient(`${spec.label}`, spec.palette, spec.min, spec.max, spec.classes[0].label, spec.classes.at(-1).label)
    : legendGradient(spec.label, spec.palette, spec.min, spec.max, 'mm', 'mm');
  const btn = $('#envLoad'); btn.disabled = true;
  setCompare(false);
  removeLayer('rasterB');
  const run = () => eeTileLayer('rasterA', `/api/env/map?${q}`, {pane: 'rasterA', label: `${spec.label} ${year}`, color: '#' + spec.palette.at(-2), legend});
  try {
    const d = await run();
    S.reloaders.set('rasterA', run);
    if (d.partial_year) toast('Data belum setahun penuh', ` CHIRPS ${year}: ${d.months} bulan (${d.start} s.d. ${d.end_inclusive}).`);
  } catch (err) { toast('Lapisan gagal dimuat', ' ' + err.message, 'err'); btn.disabled = false; return; }
  const box = $('#envStats');
  if (layer === 'rainfall') { box.innerHTML = ''; btn.disabled = false; return; }
  box.innerHTML = '<div class="skeleton"></div>';
  try {
    const s = await api(`/api/env/statistics?${q}`);
    const digits = layer === 'degradation' ? 4 : 0;
    const period = layer === 'degradation' ? `${s.trend_start_year}–${s.trend_end_year}` : `${s.start} s.d. ${s.end_inclusive}`;
    box.innerHTML = `<div class="card">
      <div class="stats"><div class="stat"><span>Rerata · ${esc(s.unit)}</span><strong>${fmt(s.mean, digits)}</strong><small>${esc(period)}</small></div>
        <div class="stat"><span>Rentang P10–P90</span><strong style="font-size:1rem">${fmt(s.p10, digits)} — ${fmt(s.p90, digits)}</strong><small>Sampel ${s.sampling_scale_m} m</small></div></div>
      <h4>Sebaran kelas</h4>
      <div class="dist">${s.classes.map((c) => `<i title="${esc(c.label)}" style="width:${(c.share || 0) * 100}%;background:${c.color}"></i>`).join('')}</div>
      <div class="dist-legend">${s.classes.map((c) => `<div><i style="background:${c.color}"></i>${esc(c.label)}<b>${pct(c.share)}</b><small>${fmtInt(c.area_km2)} km²</small></div>`).join('')}</div>
    </div>`;
  } catch (err) { box.innerHTML = `<p class="muted">Statistik gagal: ${esc(err.message)}</p>`; }
  finally { btn.disabled = false; }
}

/** Static snapshot mode: only offer periods that were pre-rendered. */
const SNAP = () => (S.status?.static && !window.EW_API_BASE ? S.status.snapshot : null);
function setOptions(select, values, labelFn = String) {
  select.innerHTML = values.map((v) => `<option value="${v}">${esc(labelFn(v))}</option>`).join('');
}
function applySnapshotLimits() {
  const sn = SNAP();
  if (!sn) return;
  setOptions($('#idxYear'), [...sn.index_map_years].reverse());
  setOptions($('#idxYearB'), sn.index_map_years);
  setOptions($('#idxMonth'), [0], () => 'Tahunan · komposit 12 bulan');
  setOptions($('#waterYear'), [sn.water_year]);
  setOptions($('#waterMonth'), [0], () => 'Tahunan · komposit 12 bulan');
}

/* ------------------------------------------------------------ WATER */
S.water = 'turbidity';
function renderWaterCards() {
  const W = S.status?.water_layers || {};
  const allowed = SNAP()?.water_layers;
  $('#waterCards').innerHTML = Object.entries(W).filter(([k]) => !allowed || allowed.includes(k)).map(([k, v]) => `<button type="button" class="idx ${k === S.water ? 'on' : ''}" data-water="${k}">
    <b>${esc(v.label)}</b><div class="ramp" style="background:${gradient(v.palette)}"></div><small>${esc(v.meaning.split('. ')[0])}.</small></button>`).join('');
  $$('[data-water]').forEach((b) => b.onclick = () => {
    S.water = b.dataset.water;
    $$('[data-water]').forEach((x) => x.classList.toggle('on', x === b));
    $('#waterStats').innerHTML = '';
    $('#waterTrend').innerHTML = '<p class="muted">Rerata tahunan untuk area fokus terpilih.</p>';
    renderWaterInfo();
    renderCdseCard('#cdseWaterCard', 'water');
  });
  const aois = S.status?.water_aois || {};
  $('#waterAoi').innerHTML = `<option value="all">Seluruh perairan (pesisir ±12 km + badan air darat)</option>` +
    Object.entries(aois).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('#waterAoi').onchange = () => { drawAoi(); $('#waterStats').innerHTML = ''; };
}

function renderWaterInfo() {
  const v = S.status?.water_layers?.[S.water];
  if (!v) return;
  const oil = Boolean(v.monthly_only);
  const months = MONTHS.map((m, i) => `<option value="${i}">${i ? m : 'Tahunan · komposit 12 bulan'}</option>`);
  const cur = $('#waterMonth').value;
  if (SNAP()) { $('#waterTrendCard').classList.add('hidden'); }
  else $('#waterMonth').innerHTML = (oil ? months.slice(1) : months).join('');
  const last = new Date().getMonth();  // last complete month index (1..12) of current year = getMonth()
  $('#waterMonth').value = oil ? String(cur && cur !== '0' ? cur : Math.max(1, last)) : (cur || '0');
  $('#waterTrendCard').classList.toggle('hidden', oil || Boolean(SNAP()));
  $('#waterTrendTitle').textContent = `Tren tahunan ${v.label}`;
  $('#waterMethod').innerHTML = `<p><b>${esc(v.label)}</b> (${esc(v.unit)})<br>Rumus: <code>${esc(v.formula)}</code></p><p>${esc(v.meaning)}</p><p>Sumber: ${esc(v.source)}.${oil ? ' Hanya per bulan; statistik hanya untuk area fokus (perhitungan radar berat).' : ''}</p>`;
}

function drawAoi() {
  removeLayer('aoi');
  const k = $('#waterAoi').value;
  const a = S.status?.water_aois?.[k];
  if (!a || !S.map) return;
  const [w, s, e, n] = a.bbox;
  const rect = L.rectangle([[s, w], [n, e]], {pane: 'boundary', color: '#f97316', weight: 2, dashArray: '6 4', fill: false, interactive: false});
  setLayer('aoi', rect, {label: `Area fokus: ${a.label}`, color: '#f97316', opacity: false});
  S.map.flyToBounds(rect.getBounds(), {padding: [40, 40], duration: .8});
}

const waterQ = (year) => `layer=${S.water}&year=${year}&month=${$('#waterMonth').value}&area=${S.area}`;

async function loadWater() {
  if (needEE()) return;
  const v = S.status.water_layers[S.water];
  const year = Number($('#waterYear').value), month = Number($('#waterMonth').value);
  const aoi = $('#waterAoi').value;
  const per = month ? ' ' + MONTHS[month] : '';
  const btn = $('#waterLoad'); btn.disabled = true;
  setCompare(false);
  if (S.layers.has('rasterB')) removeLayer('rasterB');
  const legend = legendGradient(`${v.label} (${v.unit})`, v.palette, v.min, v.max, '', '');
  const run = () => eeTileLayer('rasterA', `/api/water/map?${waterQ(year)}`, {pane: 'rasterA', label: `${v.label} ${year}${per}`, color: '#' + v.palette.at(-2), legend});
  try {
    await run();
    S.reloaders.set('rasterA', run);
  } catch (err) { toast('Lapisan gagal dimuat', ' ' + err.message, 'err'); btn.disabled = false; return; }
  const box = $('#waterStats');
  if (v.monthly_only && aoi === 'all') {
    box.innerHTML = '<p class="muted">Pilih satu area fokus untuk menghitung statistik bercak minyak.</p>';
    btn.disabled = false; return;
  }
  box.innerHTML = '<div class="skeleton"></div>';
  try {
    const st = await api(`/api/water/statistics?${waterQ(year)}&aoi=${aoi}`);
    const d = S.water === 'sst' ? 1 : S.water === 'turbidity' ? 1 : S.water === 'oil' ? 1 : 3;
    const where = aoi === 'all' ? 'Seluruh perairan' : S.status.water_aois[aoi].label;
    const note = st.scenes !== undefined ? ` · ${st.scenes} citra radar` : '';
    box.innerHTML = `<div class="card">
      <div class="stats"><div class="stat"><span>Rerata · ${esc(v.unit)}</span><strong>${fmt(st.mean, d)}</strong><small>${esc(where)}</small></div>
      <div class="stat"><span>Rentang P10–P90</span><strong style="font-size:1rem">${fmt(st.p10, d)} — ${fmt(st.p90, d)}</strong><small>${st.start} s.d. ${st.end_inclusive}${note}</small></div></div>
      ${st.classes ? `<h4>Sebaran kelas</h4><div class="dist">${st.classes.map((c) => `<i title="${esc(c.label)}" style="width:${(c.share || 0) * 100}%;background:${c.color}"></i>`).join('')}</div>
      <div class="dist-legend">${st.classes.map((c) => `<div><i style="background:${c.color}"></i>${esc(c.label)}<b>${pct(c.share)}</b></div>`).join('')}</div>` : ''}
      ${st.mean === null ? '<p class="muted">Tidak ada piksel air valid (tertutup awan / di luar cakupan) untuk periode ini.</p>' : ''}
    </div>`;
  } catch (err) { box.innerHTML = `<p class="muted">Statistik gagal: ${esc(err.message)}</p>`; }
  finally { btn.disabled = false; }
}

async function loadWaterTrend() {
  if (needEE()) return;
  const v = S.status.water_layers[S.water];
  const aoi = $('#waterAoi').value;
  const m = Number($('#waterMonth').value);
  const now = new Date();
  const years = [];
  for (let y = v.first_year; y <= S.currentYear; y++) {
    if (y === S.currentYear && (m ? m >= now.getMonth() + 1 : now.getMonth() === 0)) continue;
    years.push(y);
  }
  const btn = $('#waterTrendBtn'); btn.disabled = true;
  const chart = $('#waterTrend');
  const pts = [];
  try {
    for (const y of years) {
      chart.innerHTML = `<p class="muted">Menghitung ${esc(v.label)} ${y}… (${pts.length + 1}/${years.length})</p>`;
      try { const d = await api(`/api/water/statistics?${waterQ(y)}&aoi=${aoi}`); pts.push({x: y, y: d.mean, p10: d.p10, p90: d.p90}); }
      catch { pts.push({x: y, y: null}); }
    }
    chart.innerHTML = lineChart(pts, '#' + v.palette.at(-2));
  } finally { btn.disabled = false; }
}

/* --------------------------------------------- DEFORESTATION & LAND CHANGE */
function barChart(series, color) {
  const W = 400, H = 170, P = {l: 34, r: 8, t: 12, b: 24};
  const max = Math.max(1, ...series.map((d) => d.km2));
  const bw = (W - P.l - P.r) / series.length;
  const Y = (v) => P.t + (1 - v / max) * (H - P.t - P.b);
  const ticks = [0, max / 2, max];
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafik kehilangan tutupan pohon per tahun">
    ${ticks.map((t) => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="#e2e9e1"/><text x="${P.l - 5}" y="${Y(t) + 3}" font-size="9" text-anchor="end" fill="#7a8f88">${Math.round(t)}</text>`).join('')}
    ${series.map((d, i) => `<rect x="${P.l + i * bw + 1}" y="${Y(d.km2)}" width="${Math.max(1, bw - 2)}" height="${H - P.b - Y(d.km2)}" fill="${color}" rx="1.5"><title>${d.year}: ${fmt(d.km2, 1)} km²</title></rect>` +
      (i % 4 === 0 || i === series.length - 1 ? `<text x="${P.l + i * bw + bw / 2}" y="${H - 8}" font-size="9" text-anchor="middle" fill="#7a8f88">${d.year}</text>` : '')).join('')}
  </svg>`;
}

async function loadForestLoss() {
  if (needEE()) return;
  const spec = S.status.env_layers.forestloss;
  const mask = $('#forestMask').value;
  const btn = $('#forestLoad'); btn.disabled = true;
  setCompare(false);
  if (S.layers.has('rasterB')) removeLayer('rasterB');
  const run = () => eeTileLayer('rasterA', `/api/env/map?layer=forestloss&year=2025&mask=${mask}&area=${S.area}`, {
    pane: 'rasterA', label: 'Kehilangan tutupan pohon 2001–2025', color: '#bd0026',
    legend: legendGradient('Tahun kehilangan tutupan pohon', spec.palette, 2001, 2025, 'lama', 'baru'),
  });
  try { await run(); S.reloaders.set('rasterA', run); }
  catch (err) { toast('Peta deforestasi gagal dimuat', ' ' + err.message, 'err'); }
  const box = $('#forestStats');
  box.innerHTML = '<div class="skeleton"></div>';
  try {
    const d = await api(`/api/env/forestloss?mask=${mask}&area=${S.area}`);
    const peak = d.series.reduce((a, b) => (b.km2 > a.km2 ? b : a), d.series[0]);
    const last5 = d.series.slice(-5).reduce((a, b) => a + b.km2, 0);
    box.innerHTML = `<div class="stats"><div class="stat"><span>Total hilang 2001–2025</span><strong>${fmtInt(d.total_km2)} km²</strong><small>${fmtInt(d.total_km2 * 100)} ha</small></div>
      <div class="stat"><span>Tahun tertinggi</span><strong>${peak.year}</strong><small>${fmt(peak.km2, 1)} km² · 5 thn terakhir ${fmtInt(last5)} km²</small></div></div>
      <div class="chart">${barChart(d.series, '#dc2626')}</div><p class="fine">${esc(d.source)}</p>`;
  } catch (err) { box.innerHTML = `<p class="muted">Statistik gagal: ${esc(err.message)}</p>`; }
  finally { btn.disabled = false; }
}

async function loadLandChange() {
  if (needEE()) return;
  const classes = S.status.land_change_classes || [];
  const btn = $('#changeLoad'); btn.disabled = true;
  setCompare(false);
  if (S.layers.has('rasterB')) removeLayer('rasterB');
  const run = () => eeTileLayer('rasterA', `/api/env/map?layer=landchange&year=2025&mask=region&area=${S.area}`, {
    pane: 'rasterA', label: 'Alih fungsi lahan 2005 → 2025', color: '#dc2626',
    legend: legendCats('Alih fungsi lahan 2005 → 2025', classes),
  });
  try { await run(); S.reloaders.set('rasterA', run); }
  catch (err) { toast('Peta alih fungsi gagal dimuat', ' ' + err.message, 'err'); }
  const box = $('#changeStats');
  box.innerHTML = '<div class="skeleton"></div>';
  try {
    const d = await api(`/api/env/landchange?end=2025&area=${S.area}`);
    const total = d.classes.reduce((a, c) => a + c.area_km2, 0);
    box.innerHTML = `<div class="dist">${d.classes.map((c) => `<i title="${esc(c.label)}" style="width:${total ? c.area_km2 / total * 100 : 0}%;background:${c.color}"></i>`).join('')}</div>
      <div class="dist-legend">${d.classes.map((c) => `<div><i style="background:${c.color}"></i>${esc(c.label)}<b>${fmtInt(c.area_km2)} km²</b></div>`).join('')}</div>
      <p class="fine">Total area berubah ${fmtInt(d.total_km2)} km² · sampel ${d.sampling_scale_m} m · ${esc(d.source)}</p>`;
  } catch (err) { box.innerHTML = `<p class="muted">Statistik gagal: ${esc(err.message)}</p>`; }
  finally { btn.disabled = false; }
}

/* ---------------------------------------------------------- POINT */
async function onMapClick(e) {
  if (S.skipClick) { S.skipClick = false; return; }
  const {lat, lng} = e.latlng;
  const head = `<div class="pt"><h4>Profil lokasi</h4><div class="coord">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>`;
  if (!S.ready && !(S.status?.static && window.EW_API_BASE)) {
    const msg = S.status?.static
      ? 'Profil titik dihitung langsung oleh Earth Engine, jadi hanya tersedia di versi server EnviroWatch.'
      : 'Hubungkan Earth Engine untuk membaca nilai indeks, erosivitas, dan tren pada titik ini.';
    L.popup().setLatLng(e.latlng).setContent(`${head}<p class="muted">${msg}</p></div>`).openOn(S.map);
    return;
  }
  const year = S.module === 'land' ? Number($('#idxYear').value) : S.currentYear - 1;
  const month = S.module === 'land' ? Number($('#idxMonth').value) : 0;
  const popup = L.popup({maxWidth: 300}).setLatLng(e.latlng).setContent(`${head}<p class="muted"><span class="spinner" style="border-color:#cfe3c7;border-top-color:#145243;display:inline-block;vertical-align:middle"></span> Membaca Earth Engine…</p></div>`).openOn(S.map);
  try {
    const d = await api(`/api/point?lat=${lat}&lon=${lng}&year=${year}&month=${month}`);
    const I = S.status.indices;
    const trend = d.ndvi_trend_per_year;
    const tTag = trend === null || trend === undefined ? '' : trend < -0.003 ? '<span class="tag" style="background:#fde2dd;color:#a3271a">Indikasi degradasi</span>'
      : trend > 0.003 ? '<span class="tag" style="background:#dcf3d9;color:#14632d">Indikasi perbaikan</span>' : '<span class="tag" style="background:#f3f3e3;color:#5b5b2a">Stabil</span>';
    popup.setContent(`${head}
      <table>
        ${Object.keys(I).map((k) => `<tr><td>${I[k].label} ${year}${month ? ' ' + MONTHS[month] : ''}</td><td>${fmt(d.indices[k])}</td></tr>`).join('')}
        <tr><td>Erosivitas R ${d.rain_year ?? ''}</td><td>${fmtInt(d.erosivity)}</td></tr>
        <tr><td>Curah hujan ${d.rain_year ?? ''}</td><td>${fmtInt(d.rainfall_mm)} mm</td></tr>
        <tr><td>Tren NDVI ${d.trend_years[0]}–${d.trend_years[1]}</td><td>${fmt(trend, 4)}/th</td></tr>
        <tr><td>Ketinggian</td><td>${fmtInt(d.elevation_m)} m</td></tr>
        <tr><td>Kemiringan</td><td>${fmt(d.slope_deg, 1)}°</td></tr>
        <tr><td>Tutupan 2021</td><td>${esc(d.landcover ?? '—')}</td></tr>
      </table><div style="margin-top:8px">${tTag}</div></div>`);
  } catch (err) {
    popup.setContent(`${head}<p class="muted">Gagal: ${esc(err.message)}</p></div>`);
  }
}

/* ---------------------------------------------------------- INIT */
function applyTheme(theme, save = false) {
  document.documentElement.dataset.theme = theme;
  $('#themeBtn').textContent = theme === 'dark' ? '☀' : '☾';
  $('meta[name=theme-color]').setAttribute('content', theme === 'dark' ? '#08211d' : '#0b2f29');
  if (save) { try { localStorage.setItem('ew-theme', theme); } catch { /* private mode */ } }
}

/* ---------------------------------------------- mobile bottom sheet (drag) */
const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
const SHEET = {peek: () => 92, half: () => window.innerHeight * 0.48, full: () => window.innerHeight - 130};
function setSheet(state) {
  if (!isMobile()) return;
  S.sheet = state;
  document.querySelector('.shell').style.setProperty('--sheet-h', `${Math.round(SHEET[state]())}px`);
}
/** Fit the study area in the part of the map not covered by the mobile bottom sheet. */
function fitArea(bounds) {
  if (!S.map || !bounds?.isValid()) return;
  S.map.invalidateSize();
  const sheet = isMobile() ? $('#panel').getBoundingClientRect().height : 0;
  S.map.flyToBounds(bounds, {paddingTopLeft: [16, 56], paddingBottomRight: [16, 16 + sheet], duration: .8});
}
function initSheet() {
  const panel = $('#panel'), handle = $('#sheetHandle'), shell = document.querySelector('.shell');
  let startY = 0, startH = 0, moved = false, dragging = false;
  const height = () => panel.getBoundingClientRect().height;
  const down = (e) => {
    if (!isMobile()) return;
    dragging = true; moved = false; startY = e.clientY; startH = height();
    panel.classList.add('dragging'); handle.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    const h = Math.min(SHEET.full(), Math.max(SHEET.peek(), startH - dy));
    shell.style.setProperty('--sheet-h', `${h}px`);
  };
  const up = () => {
    if (!dragging) return;
    dragging = false; panel.classList.remove('dragging');
    if (!moved) { setSheet({peek: 'half', half: 'full', full: 'peek'}[S.sheet || 'half']); return; }
    const h = height();
    const nearest = Object.keys(SHEET).sort((x, y) => Math.abs(SHEET[x]() - h) - Math.abs(SHEET[y]() - h))[0];
    setSheet(nearest);
  };
  handle.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  window.addEventListener('resize', () => { setSheet(S.sheet || 'half'); S.map?.invalidateSize(); });
  setSheet('half');
  // Layout (header/sheet) settles after first paint: resize the map, then frame the study area.
  setTimeout(() => { S.map?.invalidateSize(); fitArea(L.latLngBounds(BOUNDS[S.area])); }, 350);
  // Legend: tap the title to fold/unfold (saves space on phones).
  $('#legend').addEventListener('click', (e) => { if (e.target.closest('h5')) $('#legend').classList.toggle('collapsed'); });
}

function wire() {
  applyTheme(document.documentElement.dataset.theme || 'light');
  $('#themeBtn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
  $$('.rail-btn').forEach((b) => b.onclick = () => setModule(b.dataset.module));
  $$('[data-go]').forEach((b) => b.onclick = () => setModule(b.dataset.go));
  $$('#areaSeg button').forEach((b) => b.onclick = () => b.dataset.area !== S.area && setArea(b.dataset.area));
  $$('.basemaps button').forEach((b) => b.onclick = () => setBase(b.dataset.base));
  $('#opacity').oninput = () => {
    const a = Number($('#opacity').value) / 100;
    for (const it of S.layers.values()) if (it.opacity && it.layer.setOpacity) it.layer.setOpacity(a);
  };
  $('#swipe').oninput = updateClip;
  $('#lcToggle').onchange = (e) => toggleLandcover(e.target.checked, 'landcover', false);
  $('#habitatToggle').onchange = (e) => toggleLandcover(e.target.checked, 'habitat', true);
  $$('#bioSeg button').forEach((b) => b.onclick = () => {
    S.bio = b.dataset.bio;
    $$('#bioSeg button').forEach((x) => x.classList.toggle('on', x === b));
    $('#bioForest').classList.toggle('hidden', S.bio !== 'forest');
    $('#bioPlants').classList.toggle('hidden', S.bio !== 'plants');
    $('#bioAnimals').classList.toggle('hidden', S.bio !== 'animals');
  });
  $$('#landSeg button').forEach((b) => b.onclick = () => {
    S.land = b.dataset.land;
    $$('#landSeg button').forEach((x) => x.classList.toggle('on', x === b));
    for (const [k, id] of [['index', '#landIndex'], ['defor', '#landDefor'], ['env', '#landEnv'], ['cover', '#landCover']]) {
      $(id).classList.toggle('hidden', S.land !== k);
    }
    if (S.land === 'cover') loadVector('tanah');
  });
  $$('#maskSeg button').forEach((b) => b.onclick = () => {
    S.mask = b.dataset.mask;
    $$('#maskSeg button').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('#compareToggle').onchange = (e) => {
    $('#compareYearWrap').classList.toggle('hidden', !e.target.checked);
    if (!e.target.checked && S.layers.has('rasterB')) removeLayer('rasterB');
    if (!e.target.checked) setCompare(false);
  };
  $('#idxLoad').onclick = loadIndex;
  $('#trendBtn').onclick = loadTrend;
  $$('#envSeg button').forEach((b) => b.onclick = () => {
    S.env = b.dataset.env;
    $$('#envSeg button').forEach((x) => x.classList.toggle('on', x === b));
    $('#envStats').innerHTML = '';
    renderEnvInfo();
  });
  $('#envLoad').onclick = loadEnv;
  $('#forestLoad').onclick = loadForestLoss;
  $('#changeLoad').onclick = loadLandChange;
  $('#waterLoad').onclick = loadWater;
  $('#waterTrendBtn').onclick = loadWaterTrend;
  initSheet();
  $('#areaSelect').onchange = (e) => e.target.value !== S.area && setArea(e.target.value);
}

async function init() {
  initMap();
  wire();
  try {
    S.status = await api('/api/status');
    S.ready = Boolean(S.status.ready);
    S.currentYear = S.status.current_year;
  } catch (err) {
    toast('Backend tidak terhubung', ' ' + err.message, 'err');
  }
  const badge = $('#eeBadge');
  badge.className = `pill ${S.ready || S.status?.snapshot ? 'ok' : 'off'}`;
  $('span', badge).textContent = S.ready ? 'Earth Engine terhubung' : S.status?.static ? (S.status.snapshot ? 'Snapshot Earth Engine · ' + S.status.snapshot.generated.slice(0, 10) : 'Versi statis · tanpa Earth Engine') : 'Earth Engine belum terhubung';
  badge.title = S.ready ? 'Google Earth Engine aktif' : (S.status?.error || '');
  const first = S.status?.first_year || 2020;
  $('#kpiYears').textContent = `${first}—${S.currentYear}`;
  fillYears($('#idxYear'), first, S.currentYear, S.currentYear - 1);
  fillYears($('#idxYearB'), first, S.currentYear, first);
  $('#idxMonth').innerHTML = MONTHS.map((m, i) => `<option value="${i}">${i ? m : 'Tahunan · komposit 12 bulan'}</option>`).join('');
  if (S.status) { renderIndexCards(); renderIndexMethod(); renderEnvInfo(); renderWaterCards(); renderWaterInfo(); $('#trendTitle').textContent = 'Tren tahunan NDVI'; }
  fillYears($('#waterYear'), first, S.currentYear, S.currentYear - 1);
  applySnapshotLimits();
  if (SNAP()) renderWaterInfo();
  renderSources();
  loadBoundary();
  loadFaunaKpi();
  api('/api/layers').then((c) => { S.catalog = c; renderSources(); }).catch(() => {});
  getVector('kawasan').then((d) => { if (d.available) $('#kpiForest').textContent = `${fmtInt(d.total)} km²`; }).catch(() => {});
  initLive();
  renderCdseCard('#cdseIndexCard', 'index');
  renderCdseCard('#cdseWaterCard', 'water');
  if (!S.ready && S.status && !S.status.static) toast('Mode tanpa Earth Engine', ' Kawasan hutan, DAS, sungai, biodiversitas, titik panas, udara & cuaca tetap bisa dipakai. Komposit & statistik citra butuh koneksi Earth Engine.');
}

window.addEventListener('DOMContentLoaded', init);
