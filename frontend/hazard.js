'use strict';
/* EnviroWatch — modul Bencana & Berita (berjalan di browser, cocok untuk GitHub Pages).
 *  - BNPB GIS: kejadian bencana mingguan per kab/kota, indeks bahaya InaRISK
 *  - BMKG / USGS: gempa bumi terkini
 *  - Open-Meteo: prakiraan hujan, angin, CAPE, hari tanpa hujan; GloFAS: debit sungai
 *  - Berita: /api/news (server/snapshot) + RSS Mongabay langsung
 * Bergantung pada fungsi global di app.js & live.js.
 */

const BNPB = 'https://gis.bnpb.go.id/server/rest/services';
const PROV_CODES = {all: ['31', '32', '36'], jabar: ['32'], banten: ['36'], jakarta: ['31']};

/* ------------------------------------------------------------ helpers */
function numPin(latlng, text, color, {title = '', size = 34} = {}) {
  return L.marker(latlng, {pane: 'markerPane', riseOnHover: true, title, icon: L.divIcon({className: 'aq-icon',
    html: `<div class="aq-pin" style="width:${size}px;height:${size}px;background:${color};color:${textOn(color)};--pin:${color}">${text}</div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2]})});
}
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('id-ID', {day: 'numeric', month: 'short', year: 'numeric'}) : '';
/** Normalised place name without administrative prefixes ("Kota Adm.", "Kabupaten", "Kab."). */
const norm = (s) => String(s || '').toLowerCase()
  .replace(/^(kota administrasi|kota adm\.?|kota|kabupaten|kab\.?)\s+/, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function inSelectedArea(pt) { return !AREA_PROV[S.area] || pt.provinsi === AREA_PROV[S.area]; }

/* --------------------------------------------------- InaRISK hazard tiles */
const INARISK_RULE = JSON.stringify({rasterFunction: 'Colormap', rasterFunctionArguments: {
  Colormap: [[1, 255, 237, 160], [2, 253, 141, 60], [3, 189, 0, 38]],
  Raster: {rasterFunction: 'Remap', rasterFunctionArguments: {InputRanges: [0.0001, 0.333, 0.333, 0.666, 0.666, 1.01], OutputValues: [1, 2, 3], AllowUnmatched: false}},
}});
const InaRiskLayer = L.TileLayer.extend({
  getTileUrl(coords) {
    const b = this._tileCoordsToBounds(coords);
    const sw = L.CRS.EPSG3857.project(b.getSouthWest()), ne = L.CRS.EPSG3857.project(b.getNorthEast());
    const q = new URLSearchParams({bbox: [sw.x, sw.y, ne.x, ne.y].join(','), bboxSR: 3857, imageSR: 3857, size: '256,256',
      format: 'png32', transparent: 'true', f: 'image', renderingRule: INARISK_RULE});
    return `${BNPB}/inarisk/${this.options.service}/ImageServer/exportImage?${q}`;
  },
});
const INARISK_LABEL = {
  INDEKS_BAHAYA_BANJIR: 'Bahaya banjir', INDEKS_BAHAYA_BANJIRBANDANG: 'Bahaya banjir bandang',
  INDEKS_BAHAYA_TANAHLONGSOR: 'Bahaya tanah longsor', INDEKS_BAHAYA_CUACAEKSTRIM: 'Bahaya cuaca ekstrem',
  INDEKS_BAHAYA_KEKERINGAN: 'Bahaya kekeringan', INDEKS_BAHAYA_GEMPABUMI: 'Bahaya gempa bumi',
  INDEKS_BAHAYA_KARHUTLA: 'Bahaya kebakaran hutan & lahan',
};
function toggleInaRisk(service, on) {
  const id = 'inarisk:' + service;
  if (!on) { removeLayer(id); return; }
  const label = INARISK_LABEL[service] || service;
  const layer = new InaRiskLayer('', {service, pane: 'rasterB', opacity: 0.7, maxZoom: 19, attribution: 'InaRISK BNPB'});
  setLayer(id, layer, {label: `${label} (InaRISK)`, color: '#bd0026',
    legend: legendCats(`${label} · InaRISK BNPB`, [{label: 'Rendah', color: '#ffeda0'}, {label: 'Sedang', color: '#fd8d3c'}, {label: 'Tinggi', color: '#bd0026'}])});
}

/* ------------------------------------------------- BNPB disaster events */
const EVENT_STYLE = [
  [/banjir bandang/i, '🌊', '#1d4ed8'], [/banjir|rob|genangan/i, '🌊', '#2563eb'], [/longsor/i, '⛰', '#92400e'],
  [/puting|angin|cuaca/i, '🌪', '#7c3aed'], [/kebakaran|karhutla/i, '🔥', '#ea580c'], [/gempa/i, '🌍', '#be123c'],
  [/kekeringan/i, '☀', '#ca8a04'], [/gelombang|abrasi/i, '🌊', '#0d9488'], [/erupsi|gunung/i, '🌋', '#7f1d1d'],
];
const eventStyle = (cat) => (EVENT_STYLE.find(([re]) => re.test(cat || '')) || [null, '⚠', '#475569']).slice(1);

async function kabIndex() {
  const pts = await kabPoints();
  const idx = new Map();
  for (const p of pts) {
    const isKota = /^kota /i.test(p.name);
    idx.set((isKota ? 'kota ' : '') + norm(p.name), p);
    if (!idx.has(norm(p.name)) || !isKota) idx.set(norm(p.name), p);  // bare name -> kabupaten
  }
  return {pts, idx};
}

async function loadEvents() {
  const btn = $('#eventLoad'); btn.disabled = true;
  const box = $('#eventList');
  box.innerHTML = '<div class="skeleton"></div>';
  try {
    const codes = PROV_CODES[S.area] || PROV_CODES.all;
    const fields = 'dt,kabupaten,kategori_bencana,jumlah_kejadian,meninggal,hilang,luka_sakit,mengungsi,rumah_rusak,rumah_terendam,lahan_hektar,kronologis,kondisi_mutakhir,id_kab_sdi';
    // BNPB fails on OR-combined filters: fetch the week's reports (a few dozen) and filter by province code.
    const url = window.EW_STATIC
      ? `${BNPB}/Kejadian_Bencana_Mingguan/MapServer/25/query?` + new URLSearchParams({where: '1=1', outFields: fields, returnGeometry: 'false', f: 'json'})
      : `/api/bnpb/events?codes=${codes.join(',')}`;
    const [raw, {idx}] = await Promise.all([getJSON(url), kabIndex()]);
    if (raw.error) throw new Error(raw.error.message || 'BNPB menolak permintaan');
    const all = raw.features || [];
    const d = {features: all.filter((f) => codes.some((c) => String(f.attributes.id_kab_sdi || '').startsWith(c)))
      .sort((a, b) => (b.attributes.dt || 0) - (a.attributes.dt || 0))};
    const total = {count: raw.total ?? all.length};
    const rows = (d.features || []).map((f) => f.attributes);
    const markers = [];
    const seen = new Map();
    for (const r of rows) {
      // id_kab_sdi "32.73" -> kota if the BPS code's 3rd digit is 7 (kota); name match otherwise.
      const isKota = /\.7\d$/.test(r.id_kab_sdi || '');
      const p = idx.get((isKota ? 'kota ' : '') + norm(r.kabupaten)) || idx.get(norm(r.kabupaten));
      if (!p) continue;
      const n = seen.get(p.name) || 0; seen.set(p.name, n + 1);
      const [icon, color] = eventStyle(r.kategori_bencana);
      const ll = [p.lat + 0.03 * Math.sin(n * 2.1), p.lon + 0.03 * Math.cos(n * 2.1)];
      const m = numPin(ll, icon, color, {title: r.kategori_bencana});
      m.bindPopup(eventPopup(r, p));
      m.on('click', () => { S.skipClick = true; });
      markers.push(m); r._marker = m; r._place = p;
    }
    setLayer('events', L.layerGroup(markers), {label: `Kejadian bencana pekan ini (${rows.length})`, color: '#be123c', opacity: false,
      legend: legendCats('Kejadian bencana (BNPB)', [...new Map(rows.map((r) => [r.kategori_bencana, eventStyle(r.kategori_bencana)])).entries()]
        .map(([cat, [icon, color]]) => ({label: `${icon} ${cat}`, color})))});
    box.innerHTML = rows.length
      ? `<p class="fine">${rows.length} laporan di wilayah terpilih · ${total.count ?? '—'} laporan se-Indonesia pekan ini · sumber BNPB</p>` +
        rows.map((r, i) => {
          const [icon, color] = eventStyle(r.kategori_bencana);
          const impact = [['meninggal', 'meninggal'], ['mengungsi', 'mengungsi'], ['rumah_terendam', 'rumah terendam'], ['rumah_rusak', 'rumah rusak'], ['lahan_hektar', 'ha lahan']]
            .filter(([k]) => r[k] > 0).map(([k, l]) => `${fmtInt(r[k])} ${l}`).join(' · ');
          return `<button type="button" class="event-card" data-ev="${i}"><span class="ev-icon" style="background:${color}">${icon}</span>
            <span class="ev-body"><b>${esc(r.kategori_bencana)} · ${esc(r.kabupaten)}</b><small>${fmtDate(r.dt)}${impact ? ' · ' + esc(impact) : ''}</small>
            <small class="ev-text">${esc((r.kronologis || '').trim().slice(0, 180))}${(r.kronologis || '').length > 180 ? '…' : ''}</small></span></button>`;
        }).join('')
      : `<p class="muted">Tidak ada laporan kejadian bencana di wilayah terpilih pekan ini. Se-Indonesia: ${total.count ?? '—'} laporan.</p>`;
    $$('[data-ev]', box).forEach((b) => b.onclick = () => {
      const r = rows[Number(b.dataset.ev)];
      if (!r._marker) return;
      S.map.flyTo(r._marker.getLatLng(), 10, {duration: .8});
      setTimeout(() => r._marker.openPopup(), 900);
    });
    if (markers.length) S.map.flyToBounds(L.featureGroup(markers).getBounds().pad(0.3), {duration: .8, maxZoom: 10});
  } catch (err) {
    box.innerHTML = `<p class="muted">Data BNPB belum dapat dimuat: ${esc(err.message)}</p>`;
  } finally { btn.disabled = false; }
}

function eventPopup(r, p) {
  const rows = [['Kejadian', r.jumlah_kejadian], ['Meninggal', r.meninggal], ['Hilang', r.hilang], ['Luka/sakit', r.luka_sakit],
    ['Mengungsi', r.mengungsi], ['Rumah terendam', r.rumah_terendam], ['Rumah rusak', r.rumah_rusak], ['Lahan (ha)', r.lahan_hektar]]
    .filter(([, v]) => v > 0).map(([k, v]) => `<tr><td>${k}</td><td>${fmtInt(v)}</td></tr>`).join('');
  return `<div class="pt"><h4>${esc(r.kategori_bencana)}</h4><div class="coord">${esc(p.name)} · ${fmtDate(r.dt)} · BNPB</div>
    <table>${rows}</table>${r.kronologis ? `<p class="pop-text">${esc(r.kronologis.trim().slice(0, 400))}</p>` : ''}
    ${r.kondisi_mutakhir ? `<p class="pop-text"><b>Kondisi:</b> ${esc(r.kondisi_mutakhir.trim().slice(0, 200))}</p>` : ''}</div>`;
}

/* ---------------------------------------------------------- earthquakes */
async function loadQuakes() {
  const btn = $('#quakeLoad'); btn.disabled = true;
  const box = $('#quakeList');
  box.innerHTML = '<div class="skeleton"></div>';
  const src = $('#quakeSource').value;
  try {
    let quakes;
    if (src === 'usgs') {
      const start = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
      const d = await getJSON(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=-10&maxlatitude=-4&minlongitude=103.5&maxlongitude=110&minmagnitude=2.5&orderby=time&starttime=${start}`);
      quakes = d.features.map((f) => ({lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], depth: f.geometry.coordinates[2],
        mag: f.properties.mag, place: f.properties.place, time: f.properties.time, felt: '', source: 'USGS'}));
    } else {
      const file = src === 'bmkg-felt' ? 'gempadirasakan' : 'gempaterkini';
      const d = await getJSON(`https://data.bmkg.go.id/DataMKG/TEWS/${file}.json`);
      quakes = d.Infogempa.gempa.map((g) => {
        const [lat, lon] = g.Coordinates.split(',').map(Number);
        return {lat, lon, depth: parseFloat(g.Kedalaman), mag: parseFloat(g.Magnitude), place: g.Wilayah, time: g.DateTime,
          felt: g.Dirasakan || '', potensi: g.Potensi || '', source: 'BMKG'};
      });
    }
    const depthColor = (d) => d < 70 ? '#dc2626' : d < 300 ? '#f97316' : '#eab308';
    const markers = quakes.map((q) => {
      const m = L.circleMarker([q.lat, q.lon], {pane: 'boundary', radius: 4 + q.mag * q.mag * 0.9, color: '#111827', weight: 1,
        fillColor: depthColor(q.depth), fillOpacity: .7});
      m.bindPopup(`<div class="pt"><h4>M ${fmt(q.mag, 1)} · ${esc(q.place)}</h4><div class="coord">${new Date(q.time).toLocaleString('id-ID')} · ${q.source}</div>
        <table><tr><td>Kedalaman</td><td>${fmt(q.depth, 0)} km</td></tr>${q.felt ? `<tr><td>Dirasakan</td><td>${esc(q.felt)}</td></tr>` : ''}${q.potensi ? `<tr><td>Potensi</td><td>${esc(q.potensi)}</td></tr>` : ''}</table></div>`);
      m.on('click', () => { S.skipClick = true; });
      return m;
    });
    S.map.getPane('boundary').style.pointerEvents = 'auto';
    setLayer('quakes', L.layerGroup(markers), {label: `Gempa (${quakes.length}) · ${src === 'usgs' ? 'USGS 30 hari' : 'BMKG'}`, color: '#dc2626', opacity: false,
      legend: legendCats('Gempa · warna = kedalaman, ukuran = magnitudo', [{label: 'Dangkal < 70 km', color: '#dc2626'}, {label: 'Menengah 70–300 km', color: '#f97316'}, {label: 'Dalam > 300 km', color: '#eab308'}])});
    box.innerHTML = `<p class="fine">${quakes.length} gempa · sumber ${src === 'usgs' ? 'USGS' : 'BMKG'}</p>` + quakes.slice(0, 20).map((q, i) =>
      `<button type="button" class="event-card" data-q="${i}"><span class="ev-icon" style="background:${depthColor(q.depth)}">${fmt(q.mag, 1)}</span>
        <span class="ev-body"><b>${esc(q.place)}</b><small>${new Date(q.time).toLocaleString('id-ID')} · ${fmt(q.depth, 0)} km${q.felt ? ' · dirasakan ' + esc(q.felt.slice(0, 80)) : ''}</small></span></button>`).join('');
    $$('[data-q]', box).forEach((b) => b.onclick = () => { const m = markers[Number(b.dataset.q)]; S.map.flyTo(m.getLatLng(), 8, {duration: .8}); setTimeout(() => m.openPopup(), 900); });
    if (markers.length) S.map.flyToBounds(L.featureGroup(markers).getBounds().pad(0.2), {duration: .8, maxZoom: 8});
  } catch (err) {
    box.innerHTML = `<p class="muted">Data gempa belum dapat dimuat: ${esc(err.message)}</p>`;
  } finally { btn.disabled = false; }
}

/* ----------------------------------------- flood / landslide potential */
const RAIN_CLASS = [[20, '#93c5fd', 'Ringan–sedang'], [50, '#3b82f6', 'Sedang'], [100, '#f59e0b', 'Lebat'], [150, '#dc2626', 'Sangat lebat'], [1e9, '#7f1d1d', 'Ekstrem']];
const rainClass = (mm) => RAIN_CLASS.find(([max]) => mm < max);
const RIVERS = [
  ['Citarum hilir (Muara Gembong)', -5.98, 107.03], ['Citarum hulu (Dayeuhkolot)', -6.99, 107.63], ['Ciliwung (Manggarai)', -6.21, 106.85],
  ['Cisadane (Tangerang)', -6.17, 106.63], ['Cimanuk (Indramayu)', -6.34, 108.32], ['Citanduy (Banjar)', -7.37, 108.53],
  ['Ciujung (Serang)', -6.11, 106.30], ['Cimandiri (Palabuhanratu)', -6.98, 106.55], ['Cibeet–Bekasi (Bekasi)', -6.24, 107.00],
];

async function openMeteoMany(pts, params, api = 'https://api.open-meteo.com/v1/forecast') {
  const q = `latitude=${pts.map((p) => p.lat).join(',')}&longitude=${pts.map((p) => p.lon).join(',')}&${params}&timezone=Asia%2FJakarta`;
  const d = await getJSON(`${api}?${q}`);
  return Array.isArray(d) ? d : [d];
}

async function loadFloodPotential() {
  const btn = $('#floodLoad'); btn.disabled = true;
  const box = $('#floodList');
  box.innerHTML = '<div class="skeleton"></div>';
  try {
    const pts = (await kabPoints()).filter(inSelectedArea);
    const rivers = RIVERS.map(([name, lat, lon]) => ({name, lat, lon}));
    const [wx, fl] = await Promise.all([
      openMeteoMany(pts, 'daily=precipitation_sum&forecast_days=3'),
      openMeteoMany(rivers, 'daily=river_discharge&past_days=365&forecast_days=7', 'https://flood-api.open-meteo.com/v1/flood'),
    ]);
    const layers = [];
    pts.forEach((p, i) => {
      const days = wx[i]?.daily?.precipitation_sum || [];
      p.rainMax = Math.max(0, ...days.filter((v) => v !== null));
      p.rain3 = days.reduce((a, v) => a + (v || 0), 0);
      const [, color, label] = rainClass(p.rainMax);
      const m = numPin([p.lat, p.lon], Math.round(p.rainMax), color, {title: p.name});
      m.bindPopup(`<div class="pt"><h4>${esc(p.name)}</h4><div class="coord">Prakiraan hujan 3 hari (Open-Meteo)</div><table>
        ${(wx[i]?.daily?.time || []).map((t, k) => `<tr><td>${fmtDate(t)}</td><td>${fmt(days[k], 1)} mm</td></tr>`).join('')}
        <tr><td>Kategori harian tertinggi</td><td>${label}</td></tr></table>
        <p class="pop-text">${p.rainMax >= 50 ? 'Hujan lebat: waspada banjir di dataran rendah & longsor di lereng curam.' : 'Belum ada indikasi hujan lebat.'}</p></div>`);
      layers.push(m);
    });
    rivers.forEach((r, i) => {
      // Compare the 7-day forecast peak with the last 365 days (75th / 90th percentile), not a seasonal mean.
      const q = fl[i]?.daily?.river_discharge || [];
      const past = q.slice(0, 365).filter((v) => v !== null).sort((a, b) => a - b), next = q.slice(365).filter((v) => v !== null);
      const pct = (p) => past.length ? past[Math.min(past.length - 1, Math.floor(p * past.length))] : null;
      r.p75 = pct(0.75); r.p90 = pct(0.9); r.median = pct(0.5);
      r.peak = Math.max(0, ...next);
      r.level = r.p90 === null ? null : r.peak >= r.p90 ? 'tinggi' : r.peak >= r.p75 ? 'naik' : 'normal';
      const mean = r.median;
      r.ratio = r.median ? r.peak / r.median : null;
      const color = r.level === null ? '#94a3b8' : r.level === 'tinggi' ? '#dc2626' : r.level === 'naik' ? '#f59e0b' : '#0ea5e9';
      const m = L.marker([r.lat, r.lon], {pane: 'markerPane', icon: L.divIcon({className: 'aq-icon', iconSize: [30, 30], iconAnchor: [15, 15],
        html: `<div class="river-pin" style="--c:${color}">≋</div>`})});
      m.bindPopup(`<div class="pt"><h4>${esc(r.name)}</h4><div class="coord">Debit sungai GloFAS (±5 km grid)</div><table>
        <tr><td>Puncak 7 hari ke depan</td><td>${fmt(r.peak, 0)} m³/s</td></tr><tr><td>Median 1 tahun</td><td>${fmt(mean, 0)} m³/s</td></tr>
        <tr><td>Persentil 75 / 90</td><td>${fmt(r.p75, 0)} / ${fmt(r.p90, 0)} m³/s</td></tr><tr><td>Status</td><td>${r.level || '—'}</td></tr></table></div>`);
      layers.push(m);
    });
    setLayer('flood', L.layerGroup(layers), {label: 'Potensi banjir & longsor (3 hari)', color: '#2563eb', opacity: false,
      legend: legendCats('Hujan harian tertinggi 3 hari (mm)', RAIN_CLASS.map(([max, color, label]) => ({color, label: `${label}${max < 1e8 ? ' < ' + max : ''}`})))
        + '<div class="ends"><span>≋ = debit sungai 7 hari ke depan: biru normal, oranye di atas persentil 75, merah di atas persentil 90 setahun terakhir</span></div>'});
    const heavy = pts.filter((p) => p.rainMax >= 50).sort((a, b) => b.rainMax - a.rainMax);
    const highRivers = rivers.filter((r) => r.level === 'naik' || r.level === 'tinggi').sort((a, b) => b.ratio - a.ratio);
    box.innerHTML = `<div class="stats"><div class="stat"><span>Kab/kota hujan lebat (≥ 50 mm/hari)</span><strong>${heavy.length}</strong><small>dari ${pts.length}</small></div>
      <div class="stat"><span>Sungai debit di atas normal</span><strong>${highRivers.length}</strong><small>dari ${rivers.length} titik (≥ persentil 75)</small></div></div>
      ${heavy.length ? `<p class="muted"><b>Waspada:</b> ${heavy.slice(0, 8).map((p) => `${esc(p.name)} (${fmt(p.rainMax, 0)} mm)`).join(', ')}</p>` : '<p class="muted">Belum ada prakiraan hujan lebat dalam 3 hari.</p>'}
      ${highRivers.length ? `<p class="muted"><b>Debit di atas normal:</b> ${highRivers.map((r) => `${esc(r.name)} (${r.level})`).join(', ')}</p>` : ''}`;
  } catch (err) {
    box.innerHTML = `<p class="muted">Prakiraan belum dapat dimuat: ${esc(err.message)}</p>`;
  } finally { btn.disabled = false; }
}

/* ------------------------------------- extreme weather & drought (HTH) */
async function loadWeatherRisk() {
  const btn = $('#weatherLoad'); btn.disabled = true;
  const box = $('#weatherList');
  box.innerHTML = '<div class="skeleton"></div>';
  try {
    const pts = (await kabPoints()).filter(inSelectedArea);
    const wx = await openMeteoMany(pts, 'daily=precipitation_sum,wind_gusts_10m_max&hourly=cape&forecast_days=3&wind_speed_unit=kmh');
    const levels = [['Aman', '#22c55e'], ['Waspada', '#eab308'], ['Siaga', '#f97316'], ['Awas', '#dc2626']];
    const layers = [];
    pts.forEach((p, i) => {
      const d = wx[i]?.daily || {}, h = wx[i]?.hourly || {};
      p.gust = Math.max(0, ...(d.wind_gusts_10m_max || []).filter((v) => v !== null));
      p.rain = Math.max(0, ...(d.precipitation_sum || []).filter((v) => v !== null));
      p.cape = Math.max(0, ...(h.cape || []).filter((v) => v !== null));
      const flags = [];
      let lvl = 0;
      if (p.rain >= 50) { flags.push('hujan lebat'); lvl = Math.max(lvl, p.rain >= 100 ? 2 : 1); }
      if (p.gust >= 45) { flags.push('angin kencang'); lvl = Math.max(lvl, p.gust >= 65 ? 2 : 1); }
      if (p.cape >= 1500 && p.gust >= 40) { flags.push('potensi puting beliung'); lvl = Math.max(lvl, p.cape >= 2500 ? 3 : 2); }
      p.lvl = lvl; p.flags = flags;
      const [name, color] = levels[lvl];
      const m = numPin([p.lat, p.lon], ['✓', '!', '!!', '!!!'][lvl], color, {title: p.name});
      m.bindPopup(`<div class="pt"><h4>${esc(p.name)} · ${name}</h4><div class="coord">3 hari ke depan (Open-Meteo)</div><table>
        <tr><td>Hujan harian maks.</td><td>${fmt(p.rain, 0)} mm</td></tr><tr><td>Hembusan angin maks.</td><td>${fmt(p.gust, 0)} km/j</td></tr>
        <tr><td>CAPE maks.</td><td>${fmtInt(p.cape)} J/kg</td></tr></table>
        <p class="pop-text">${flags.length ? 'Potensi: ' + flags.join(', ') + '.' : 'Tidak ada indikasi cuaca ekstrem.'}</p></div>`);
      layers.push(m);
    });
    setLayer('weatherrisk', L.layerGroup(layers), {label: 'Potensi cuaca ekstrem (3 hari)', color: '#7c3aed', opacity: false,
      legend: legendCats('Potensi cuaca ekstrem', levels.map(([label, color]) => ({label, color})))
        + '<div class="ends"><span>Hujan ≥ 50 mm/hari, hembusan ≥ 45 km/j, CAPE ≥ 1.500 J/kg + angin = potensi puting beliung</span></div>'});
    const alert = pts.filter((p) => p.lvl > 0).sort((a, b) => b.lvl - a.lvl || b.cape - a.cape);
    box.innerHTML = alert.length
      ? `<p class="fine">${alert.length} dari ${pts.length} kab/kota berpotensi cuaca ekstrem</p>` + alert.slice(0, 12).map((p) =>
        `<div class="event-card static"><span class="ev-icon" style="background:${levels[p.lvl][1]}">${['✓', '!', '!!', '!!!'][p.lvl]}</span>
          <span class="ev-body"><b>${esc(p.name)} · ${levels[p.lvl][0]}</b><small>${esc(p.flags.join(', '))} · hujan ${fmt(p.rain, 0)} mm · angin ${fmt(p.gust, 0)} km/j</small></span></div>`).join('')
      : `<p class="muted">Tidak ada indikasi cuaca ekstrem di ${pts.length} kab/kota dalam 3 hari ke depan.</p>`;
  } catch (err) {
    box.innerHTML = `<p class="muted">Prakiraan belum dapat dimuat: ${esc(err.message)}</p>`;
  } finally { btn.disabled = false; }
}

const HTH = [[5, '#bbf7d0', 'Sangat pendek (1–5)'], [10, '#86efac', 'Pendek (6–10)'], [20, '#fde68a', 'Menengah (11–20)'],
  [30, '#fb923c', 'Panjang (21–30)'], [60, '#dc2626', 'Sangat panjang (31–60)'], [1e9, '#7f1d1d', 'Kekeringan ekstrem (> 60)']];
async function loadDrought() {
  const btn = $('#droughtLoad'); btn.disabled = true;
  const box = $('#droughtList');
  box.innerHTML = '<div class="skeleton"></div>';
  try {
    const pts = (await kabPoints()).filter(inSelectedArea);
    const wx = await openMeteoMany(pts, 'daily=precipitation_sum&past_days=92&forecast_days=1');
    const layers = [];
    pts.forEach((p, i) => {
      const rain = (wx[i]?.daily?.precipitation_sum || []).slice(0, -1);  // up to yesterday
      let n = 0;
      for (let k = rain.length - 1; k >= 0 && (rain[k] ?? 0) < 1; k--) n++;
      p.hth = n; p.rain30 = rain.slice(-30).reduce((a, v) => a + (v || 0), 0);
      const [, color, label] = HTH.find(([max]) => Math.max(n, 1) <= max);
      const m = numPin([p.lat, p.lon], n, color, {title: p.name});
      m.bindPopup(`<div class="pt"><h4>${esc(p.name)}</h4><div class="coord">Hari tanpa hujan berturut-turut (≥ 1 mm = hujan)</div><table>
        <tr><td>Hari tanpa hujan</td><td>${n} hari</td></tr><tr><td>Kategori (BMKG)</td><td>${label}</td></tr>
        <tr><td>Hujan 30 hari terakhir</td><td>${fmt(p.rain30, 0)} mm</td></tr></table></div>`);
      layers.push(m);
    });
    setLayer('drought', L.layerGroup(layers), {label: 'Hari tanpa hujan', color: '#ca8a04', opacity: false,
      legend: legendCats('Hari tanpa hujan (klasifikasi BMKG)', HTH.map(([, color, label]) => ({color, label})))});
    const dry = [...pts].sort((a, b) => b.hth - a.hth);
    box.innerHTML = `<p class="muted">Terpanjang: ${dry.slice(0, 6).map((p) => `${esc(p.name)} ${p.hth} hari`).join(', ')}.</p>
      <p class="fine">Open-Meteo (reanalisis + model) di titik pusat kab/kota. Status resmi: peta HTH BMKG.</p>`;
  } catch (err) {
    box.innerHTML = `<p class="muted">Data belum dapat dimuat: ${esc(err.message)}</p>`;
  } finally { btn.disabled = false; }
}

/* ----------------------------------------------------------------- NEWS */
let NEWS = null;
const LANDMARKS = [
  ['Citarum', -6.98, 107.55], ['Ciliwung', -6.25, 106.86], ['Cisadane', -6.35, 106.70], ['Cimanuk', -6.75, 108.10],
  ['Ujung Kulon', -6.75, 105.35], ['Halimun', -6.75, 106.45], ['Gede Pangrango', -6.78, 106.98], ['Puncak', -6.70, 106.99],
  ['Teluk Jakarta', -6.05, 106.85], ['Kepulauan Seribu', -5.75, 106.60], ['Tangkuban Parahu', -6.76, 107.61], ['Tangkuban Perahu', -6.76, 107.61],
  ['Bantar Gebang', -6.36, 106.99], ['Bantargebang', -6.36, 106.99], ['Sarimukti', -6.85, 107.37], ['Jatiluhur', -6.55, 107.37],
  ['Cirata', -6.73, 107.32], ['Saguling', -6.90, 107.37], ['Muara Gembong', -5.98, 107.03], ['Lembang', -6.81, 107.62],
  ['Kawah Putih', -7.17, 107.40], ['Gunung Salak', -6.72, 106.73], ['Krakatau', -6.10, 105.42], ['Merak', -5.93, 106.00],
  ['Suralaya', -5.89, 106.03], ['Pulau Pari', -5.86, 106.62], ['Rawa Danau', -6.18, 105.97], ['Leuwigajah', -6.90, 107.52],
];
const PROVINCES = [['Jawa Barat', -6.92, 107.6], ['Jabar', -6.92, 107.6], ['Banten', -6.40, 106.10], ['DKI Jakarta', -6.20, 106.85], ['Jakarta', -6.20, 106.85]];

async function newsGazetteer() {
  const pts = await kabPoints();
  const entries = [];
  for (const p of pts) {
    const base = p.name.replace(/^Kota Administrasi /i, '').replace(/^Kota /i, '');
    const isKota = /^kota/i.test(p.name);
    if (isKota) { entries.push([`Kota ${base}`, p, 3]); if (/Jakarta/.test(base)) entries.push([base, p, 3]); }
    else { entries.push([`Kabupaten ${base}`, p, 3], [`Kab. ${base}`, p, 3]); }
    entries.push([base, p, isKota ? 2 : 1]);  // bare name: prefer the kota when both exist
  }
  for (const [n, lat, lon] of LANDMARKS) entries.push([n, {name: n, lat, lon, provinsi: null}, 2]);
  for (const [n, lat, lon] of PROVINCES) entries.push([n, {name: n, lat, lon, provinsi: null, province: true}, 0]);
  entries.sort((a, b) => b[0].length - a[0].length || b[2] - a[2]);
  return entries.map(([n, p, w]) => [new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}])`, 'iu'), p, w, n]);
}

/** First (longest, most specific) place mentioned in the item; province names only as a fallback. */
function geocodeNews(item, gaz) {
  const text = `${item.title} ${item.locations || ''} ${item.summary || ''}`;
  let province = null;
  for (const [re, p] of gaz) {
    if (!re.test(text)) continue;
    if (!p.province) return p;
    province = province || p;
  }
  return province;
}

async function fetchMongabayLive() {
  try {
    const r = await fetch('https://www.mongabay.co.id/feed/');
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    return [...xml.querySelectorAll('item')].map((it) => {
      const get = (tag) => it.getElementsByTagName(tag)[0]?.textContent || '';
      return {title: get('title').trim(), link: get('link').trim(), source: 'Mongabay Indonesia', via: 'Mongabay Indonesia',
        published: new Date(get('pubDate')).toISOString(), summary: get('description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 320),
        locations: get('locations').replace(/\s+/g, ' ').trim(), tags: get('topic-tags').replace(/\s+/g, ' ').trim()};
    });
  } catch { return []; }
}

async function loadNews(force = false) {
  if (NEWS && !force) { renderNews(); return; }
  $('#newsList').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  const [server, live, gaz] = await Promise.all([api('/api/news').catch(() => ({items: []})), fetchMongabayLive(), newsGazetteer()]);
  const seen = new Set();
  const items = [...live, ...(server.items || [])].filter((it) => {
    const k = it.title.toLowerCase().replace(/\W+/g, '').slice(0, 80);
    if (!it.title || seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  for (const it of items) it.place = geocodeNews(it, gaz);
  NEWS = {items, fetched: server.fetched, sources: server.sources || []};
  renderNews();
}

function renderNews() {
  if (!NEWS) return;
  const mode = $('#newsSeg .on')?.dataset.news || 'region';
  const q = ($('#newsSearch').value || '').toLowerCase();
  const areaOk = (it) => !AREA_PROV[S.area] || !it.place?.provinsi || it.place.provinsi === AREA_PROV[S.area];
  const items = NEWS.items.filter((it) => (mode === 'all' || it.place) && areaOk(it) &&
    (!q || `${it.title} ${it.summary} ${it.source}`.toLowerCase().includes(q)));
  // Map: one pin per place with a count.
  const byPlace = new Map();
  for (const it of items) if (it.place) { const k = it.place.name; byPlace.set(k, [...(byPlace.get(k) || []), it]); }
  const markers = [...byPlace.entries()].map(([name, list]) => {
    const p = list[0].place;
    const m = numPin([p.lat, p.lon], list.length > 1 ? list.length : '📰', '#0f766e', {title: name, size: 32});
    m.bindPopup(`<div class="pt"><h4>📰 ${esc(name)}</h4><div class="coord">${list.length} berita</div>
      <ul class="pop-news">${list.slice(0, 6).map((it) => `<li><a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a><small>${esc(it.source)} · ${fmtDate(it.published)}</small></li>`).join('')}</ul></div>`, {maxWidth: 320});
    m.on('click', () => { S.skipClick = true; });
    return m;
  });
  setLayer('news', L.layerGroup(markers), {label: `Berita berlokasi (${byPlace.size} tempat)`, color: '#0f766e', opacity: false});
  const sources = [...new Set(NEWS.items.map((it) => it.source))].length;
  $('#newsMeta').textContent = `${items.length} berita · ${sources} sumber media · diperbarui ${NEWS.fetched ? new Date(NEWS.fetched * 1000).toLocaleString('id-ID') : 'langsung'} (Mongabay langsung)`;
  $('#newsList').innerHTML = items.length ? items.slice(0, 80).map((it, i) => `<article class="news-card">
      <a href="${esc(it.link)}" target="_blank" rel="noopener"><b>${esc(it.title)}</b></a>
      <small>${esc(it.source)} · ${fmtDate(it.published)}</small>
      ${it.summary ? `<p>${esc(it.summary.slice(0, 200))}${it.summary.length > 200 ? '…' : ''}</p>` : ''}
      ${it.place ? `<button type="button" class="place-chip" data-np="${i}">📍 ${esc(it.place.name)}</button>` : ''}
    </article>`).join('') : '<p class="muted">Tidak ada berita yang cocok.</p>';
  $$('[data-np]').forEach((b) => b.onclick = () => {
    const it = items[Number(b.dataset.np)];
    S.map.flyTo([it.place.lat, it.place.lon], 10, {duration: .8});
    const m = markers.find((mk) => mk.options.title === it.place.name);
    if (m) setTimeout(() => m.openPopup(), 900);
    if (window.matchMedia('(max-width: 760px)').matches) setSheet('peek');
  });
}

/* ------------------------------------------------------------- wiring */
function initHazard() {
  $$('#hazSeg button').forEach((b) => b.onclick = () => {
    $$('#hazSeg button').forEach((x) => x.classList.toggle('on', x === b));
    for (const [k, id] of [['events', '#hazEvents'], ['quake', '#hazQuake'], ['flood', '#hazFlood'], ['weather', '#hazWeather'], ['fire', '#hazFire']]) {
      $(id).classList.toggle('hidden', b.dataset.haz !== k);
    }
  });
  $$('[data-inarisk]').forEach((i) => i.onchange = () => toggleInaRisk(i.dataset.inarisk, i.checked));
  $('#eventLoad').onclick = loadEvents;
  $('#quakeLoad').onclick = loadQuakes;
  $('#floodLoad').onclick = loadFloodPotential;
  $('#weatherLoad').onclick = loadWeatherRisk;
  $('#droughtLoad').onclick = loadDrought;
  $$('#newsSeg button').forEach((b) => b.onclick = () => { $$('#newsSeg button').forEach((x) => x.classList.toggle('on', x === b)); renderNews(); });
  let t;
  $('#newsSearch').oninput = () => { clearTimeout(t); t = setTimeout(renderNews, 250); };
}
window.addEventListener('DOMContentLoaded', initHazard);
