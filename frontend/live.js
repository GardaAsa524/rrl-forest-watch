'use strict';
/* EnviroWatch — lapisan realtime yang berjalan langsung di browser (cocok untuk GitHub Pages):
 *  - Copernicus Data Space (Sentinel Hub WMS + evalscript)  : indeks Sentinel-2 10 m, kualitas air
 *  - NASA GIBS (WMTS/WMS, tanpa kunci)                       : titik panas, citra harian, atmosfer
 *  - Open-Meteo (tanpa kunci)                                : kualitas udara & cuaca per kab/kota
 * Bergantung pada fungsi global di app.js ($, S, setLayer, removeLayer, toast, busy, ...).
 */

const GIBS_WMTS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi';
const WORLDVIEW = 'https://worldview.earthdata.nasa.gov/';

const isoDay = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return isoDay(d); };
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };

/* ------------------------------------------------ Copernicus (Sentinel Hub) */
const CDSE_WMS = 'https://sh.dataspace.copernicus.eu/ogc/wms/';

/** Evalscript: index value -> colour ramp, clouds/shadows and invalid pixels transparent. */
function evalscript({bands, expr, palette, min, max, waterOnly = false}) {
  const stops = palette.map((p, i) => `[${(min + (max - min) * i / (palette.length - 1)).toFixed(4)},0x${p.replace('#', '')}]`).join(',');
  const inputs = [...new Set([...bands, 'SCL', 'dataMask', ...(waterOnly ? ['B03', 'B11'] : [])])];
  return `//VERSION=3
function setup(){return{input:${JSON.stringify(inputs)},output:{bands:4}};}
const viz=new ColorRampVisualizer([${stops}]);
function evaluatePixel(s){
  const bad=[0,1,3,8,9,10].includes(s.SCL);
  ${waterOnly ? 'const water=(s.B03-s.B11)/(s.B03+s.B11)>0;' : 'const water=true;'}
  const v=${expr};
  const ok=s.dataMask===1&&!bad&&water&&isFinite(v);
  const c=viz.process(ok?v:${min});
  return [c[0],c[1],c[2],ok?1:0];
}`;
}

const CDSE_SCRIPTS = {
  ndvi: {bands: ['B04', 'B08'], expr: '(s.B08-s.B04)/(s.B08+s.B04)'},
  msarvi: {bands: ['B02', 'B04', 'B08'], expr: '(2*s.B08+1-Math.sqrt(Math.pow(2*s.B08+1,2)-8*(s.B08-(s.B04-(s.B02-s.B04)))))/2'},
  ndwi: {bands: ['B03', 'B08'], expr: '(s.B03-s.B08)/(s.B03+s.B08)'},
  ndbi: {bands: ['B08', 'B11'], expr: '(s.B11-s.B08)/(s.B11+s.B08)'},
  turbidity: {bands: ['B04'], waterOnly: true, expr: '(s.B04>0&&s.B04<0.12)?355.85*s.B04/(1-s.B04/0.1728):NaN'},
  chlorophyll: {bands: ['B04', 'B05'], waterOnly: true, expr: '(s.B05-s.B04)/(s.B05+s.B04)'},
};

const cdse = () => (S.status?.cdse?.instance ? S.status.cdse : null);

function renderCdseCard(box, group) {
  const el = $(box);
  if (!el) return;
  const c = cdse();
  const which = group === 'index' ? S.status?.indices?.[S.index]?.label : S.status?.water_layers?.[S.water]?.label;
  const supported = group === 'index' || CDSE_SCRIPTS[S.water];
  if (!c) {
    el.innerHTML = `<h4>Peta realtime Sentinel-2 <span class="live-dot off">BELUM AKTIF</span></h4>
      <p class="muted">Peta 10 m terbaru dari Copernicus Data Space akan tampil di sini setelah admin mengisi <code>CDSE_INSTANCE_ID</code> (lihat README). Sementara itu gunakan komposit &amp; statistik Earth Engine di bawah.</p>`;
    return;
  }
  if (!supported) {
    el.innerHTML = `<h4>Peta realtime Sentinel-2</h4><p class="muted">${esc(which || '')} tidak tersedia dari Sentinel-2. Gunakan komposit Earth Engine di bawah.</p>`;
    return;
  }
  const id = group === 'index' ? 'cdseIdx' : 'cdseWater';
  el.innerHTML = `<h4>Peta realtime Sentinel-2 <span class="live-dot">REALTIME</span></h4>
    <p class="muted">${esc(which || '')} 10 m dari Copernicus Data Space, citra paling sedikit awan dalam rentang waktu terpilih.</p>
    <div class="form-grid">
      <label>Sampai tanggal<input type="date" id="${id}Date" value="${daysAgo(0)}" max="${daysAgo(0)}"></label>
      <label>Rentang<select id="${id}Days"><option value="10">10 hari</option><option value="30" selected>30 hari</option><option value="90">90 hari</option></select></label>
    </div>
    <button type="button" class="btn primary" id="${id}Load">Tampilkan citra terbaru</button>`;
  $(`#${id}Load`).onclick = () => showCdse(group, $(`#${id}Date`).value, Number($(`#${id}Days`).value));
}

function showCdse(group, end, days) {
  const c = cdse();
  const key = group === 'index' ? S.index : S.water;
  const spec = group === 'index' ? S.status.indices[key] : S.status.water_layers[key];
  const script = CDSE_SCRIPTS[key];
  if (!c || !spec || !script) return;
  const start = addDays(end, -days);
  const layer = L.tileLayer.wms(CDSE_WMS + encodeURIComponent(c.instance), {
    layers: c.layer || 'S2L2A', format: 'image/png', transparent: true, version: '1.3.0', uppercase: true,
    time: `${start}/${end}`, maxcc: 60, priority: 'leastCC', showlogo: false, tileSize: 512,
    evalscript: btoa(evalscript({...script, palette: spec.palette, min: spec.min, max: spec.max})),
    pane: 'rasterA', attribution: 'Contains modified Copernicus Sentinel data',
  });
  let errors = 0;
  layer.on('tileerror', () => { if (++errors === 3) toast('Copernicus tidak merespons', ' Periksa CDSE_INSTANCE_ID / nama layer, atau kuota Sentinel Hub bulan ini.', 'err'); });
  setCompare(false);
  if (S.layers.has('rasterB')) removeLayer('rasterB');
  setLayer('rasterA', layer, {label: `${spec.label} · Sentinel-2 ${start} s.d. ${end}`, color: '#' + spec.palette.at(-2),
    legend: legendGradient(`${spec.label} (Copernicus, realtime)`, spec.palette, spec.min, spec.max, spec.low || '', spec.high || '')});
  S.reloaders.delete('rasterA');
}

/* ------------------------------------------------------------- NASA GIBS */
function gibsTiles(layer, date, {tms = 'GoogleMapsCompatible_Level6', ext = 'png', label, pane = 'rasterB', opacity = 0.8} = {}) {
  const maxNative = Number(tms.match(/Level(\d+)/)[1]);
  return L.tileLayer(`${GIBS_WMTS}/${layer}/default/${date}/${tms}/{z}/{y}/{x}.${ext}`, {
    pane, maxNativeZoom: maxNative, maxZoom: 19, opacity, attribution: `NASA GIBS · ${label || layer}`,
  });
}

const GIBS_ATMOS = {
  aod: {id: 'MODIS_Combined_Value_Added_AOD', label: 'Aerosol (AOD) MODIS', lag: 1,
    note: 'Ketebalan optis aerosol: asap, debu, polusi partikel. Kuning→merah = lebih pekat.'},
  aod_viirs: {id: 'VIIRS_NOAA20_AOD_Deep_Blue_Land_Ocean', label: 'Aerosol (AOD) VIIRS', lag: 0,
    note: 'AOD VIIRS NOAA-20 Deep Blue (darat & laut).'},
  no2: {id: 'TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column', label: 'NO₂ troposfer (TROPOMI)', lag: 2,
    note: 'Nitrogen dioksida dari kendaraan, industri, PLTU. Warna terang = konsentrasi tinggi.'},
  so2: {id: 'TROPOMI_L2_Sulfur_Dioxide_Total_Vertical_Column', label: 'SO₂ (TROPOMI)', lag: 2,
    note: 'Sulfur dioksida: pembakaran batu bara, gunung api.'},
  co: {id: 'AIRS_L3_Carbon_Monoxide_500hPa_Volume_Mixing_Ratio_Daily_Day', label: 'Karbon monoksida (AIRS)', lag: 6,
    note: 'CO di 500 hPa: indikator asap kebakaran & pembakaran. Resolusi kasar (±100 km).'},
  rain: {id: 'IMERG_Precipitation_Rate', label: 'Laju hujan harian (GPM IMERG)', lag: 1,
    note: 'Laju curah hujan dari misi GPM. Biru→ungu = hujan lebih lebat.'},
};

function loadGibsAtmos() {
  const key = $('#gibsLayer').value;
  const g = GIBS_ATMOS[key];
  const date = $('#gibsDate').value || daysAgo(g.lag);
  const layer = gibsTiles(g.id, date, {label: g.label, pane: 'rasterA', opacity: 0.75});
  setLayer('atmos', layer, {label: `${g.label} · ${date}`, color: '#a855f7',
    legend: `<h5>${esc(g.label)} · ${esc(date)}</h5><div class="ends"><span>${esc(g.note)}</span></div>
      <div class="ends"><a href="${WORLDVIEW}?l=${g.id}&t=${date}" target="_blank" rel="noopener">Skala warna di NASA Worldview ↗</a></div>`});
  $('#gibsInfo').textContent = `${g.note} Data terbaru biasanya tersedia ${g.lag} hari setelah pengamatan; area kosong = awan / tidak ada lintasan satelit.`;
}

function loadFire() {
  const sensor = $('#fireSensor').value;
  const end = $('#fireDate').value || daysAgo(0);
  const days = Number($('#fireDays').value);
  const parts = [];
  for (let i = 0; i < days; i++) {
    parts.push(L.tileLayer.wms(GIBS_WMS, {
      layers: sensor, format: 'image/png', transparent: true, version: '1.3.0', time: addDays(end, -i),
      pane: 'vectors', tileSize: 512, attribution: 'NASA FIRMS / GIBS',
    }));
  }
  const group = L.layerGroup(parts);
  group.setOpacity = (o) => parts.forEach((p) => p.setOpacity(o));
  const start = addDays(end, -(days - 1));
  setLayer('fire', group, {label: `Titik panas ${start === end ? end : start + ' s.d. ' + end}`, color: '#ef4444',
    legend: `<h5>Titik panas (${esc($('#fireSensor').selectedOptions[0].textContent)})</h5>
      <div class="cats"><span><i style="background:#ff2a00"></i>Deteksi api/anomali panas</span></div>
      <div class="ends"><span>${esc(start)} s.d. ${esc(end)}</span></div>`});
  S.map.flyToBounds(BOUNDS[S.area], {duration: .8});
}

function toggleTrueColor(on) {
  if (!on) { removeLayer('truecolor'); return; }
  const date = $('#trueColorDate').value || daysAgo(0);
  setLayer('truecolor', gibsTiles('VIIRS_NOAA20_CorrectedReflectance_TrueColor', date,
    {tms: 'GoogleMapsCompatible_Level9', ext: 'jpg', label: 'VIIRS true color', pane: 'tilePane', opacity: 1}),
  {label: `Citra VIIRS ${date}`, color: '#64748b', opacity: false});
}

/* ------------------------------------------------------------- Open-Meteo */
const AIR_PARAMS = {
  us_aqi: {label: 'Indeks kualitas udara (US AQI)', src: 'air', unit: '', scale: [[50, '#22c55e', 'Baik'], [100, '#eab308', 'Sedang'], [150, '#f97316', 'Tidak sehat (sensitif)'], [200, '#ef4444', 'Tidak sehat'], [300, '#a855f7', 'Sangat tidak sehat'], [1e9, '#7f1d1d', 'Berbahaya']]},
  pm2_5: {label: 'PM2.5', src: 'air', unit: 'µg/m³', scale: [[9, '#22c55e', 'Baik'], [35.4, '#eab308', 'Sedang'], [55.4, '#f97316', 'Tidak sehat (sensitif)'], [125.4, '#ef4444', 'Tidak sehat'], [225.4, '#a855f7', 'Sangat tidak sehat'], [1e9, '#7f1d1d', 'Berbahaya']]},
  pm10: {label: 'PM10', src: 'air', unit: 'µg/m³', scale: [[54, '#22c55e', 'Baik'], [154, '#eab308', 'Sedang'], [254, '#f97316', 'Tidak sehat (sensitif)'], [354, '#ef4444', 'Tidak sehat'], [1e9, '#a855f7', 'Sangat tidak sehat']]},
  nitrogen_dioxide: {label: 'NO₂', src: 'air', unit: 'µg/m³'},
  sulphur_dioxide: {label: 'SO₂', src: 'air', unit: 'µg/m³'},
  carbon_monoxide: {label: 'CO', src: 'air', unit: 'µg/m³'},
  ozone: {label: 'Ozon (O₃)', src: 'air', unit: 'µg/m³'},
  aerosol_optical_depth: {label: 'Aerosol (AOD)', src: 'air', unit: ''},
  temperature_2m: {label: 'Suhu udara', src: 'wx', unit: '°C'},
  relative_humidity_2m: {label: 'Kelembapan', src: 'wx', unit: '%'},
  wind_speed_10m: {label: 'Kecepatan angin', src: 'wx', unit: 'km/j'},
  precipitation: {label: 'Hujan (jam terakhir)', src: 'wx', unit: 'mm'},
};
const SEQ = ['#eff6ff', '#bfdbfe', '#60a5fa', '#2563eb', '#1e3a8a'];
let AIR = null;  // {time, points:[{name, provinsi, lat, lon, air:{}, wx:{}}]}

async function kabPoints() {
  const d = await getVector('kabupaten');
  if (!d.available) throw new Error('Data kabupaten belum tersedia.');
  return d.geojson.features.map((f) => {
    const c = L.geoJSON(f).getBounds().getCenter();
    return {name: f.properties.nama, provinsi: f.properties.provinsi, lat: +c.lat.toFixed(3), lon: +c.lng.toFixed(3)};
  });
}

async function fetchAir() {
  const pts = await kabPoints();
  const lat = pts.map((p) => p.lat).join(','), lon = pts.map((p) => p.lon).join(',');
  const airVars = Object.entries(AIR_PARAMS).filter(([, v]) => v.src === 'air').map(([k]) => k).join(',');
  const wxVars = 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m';
  const [air, wx] = await Promise.all([
    fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=${airVars}&timezone=Asia%2FJakarta`).then((r) => r.json()),
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=${wxVars}&wind_speed_unit=kmh&timezone=Asia%2FJakarta`).then((r) => r.json()),
  ]);
  const A = Array.isArray(air) ? air : [air], W = Array.isArray(wx) ? wx : [wx];
  if (A[0]?.error || W[0]?.error) throw new Error(A[0]?.reason || W[0]?.reason || 'Open-Meteo menolak permintaan.');
  pts.forEach((p, i) => { p.air = A[i]?.current || {}; p.wx = W[i]?.current || {}; });
  return {time: W[0]?.current?.time || A[0]?.current?.time, points: pts};
}

function colorFor(param, v, lo, hi) {
  const sp = AIR_PARAMS[param];
  if (v === null || v === undefined) return '#94a3b8';
  if (sp.scale) return sp.scale.find(([max]) => v <= max)[1];
  const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
  return SEQ[Math.min(SEQ.length - 1, Math.max(0, Math.floor(t * SEQ.length)))];
}

/** Smooth colour for a value: interpolates between category centres (or the sequential ramp). */
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function rampFor(param, lo, hi) {
  const sp = AIR_PARAMS[param];
  let stops;
  if (sp.scale) {
    let prev = 0;
    stops = sp.scale.map(([max, color]) => {
      const top = max > 1e8 ? prev * 1.4 : max;
      const mid = (prev + top) / 2;
      prev = top;
      return [mid, hexRgb(color)];
    });
  } else {
    stops = SEQ.map((c, i) => [lo + (hi - lo) * i / (SEQ.length - 1), hexRgb(c)]);
  }
  return (v) => {
    if (v <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      if (v <= stops[i][0]) {
        const [a, ca] = stops[i - 1], [b, cb] = stops[i], t = (v - a) / (b - a || 1);
        return [0, 1, 2].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * t));
      }
    }
    return stops.at(-1)[1];
  };
}

/* Inverse-distance-weighted surface drawn on a canvas (like IQAir's map). Fades out far from stations. */
const InterpLayer = L.Layer.extend({
  initialize(points, ramp) { this.points = points; this.ramp = ramp; this.opacity = 0.62; },
  onAdd(map) {
    this._map = map;
    if (!map.getPane('interp')) { map.createPane('interp').style.zIndex = 330; map.getPane('interp').style.pointerEvents = 'none'; }
    this.canvas = L.DomUtil.create('canvas', 'interp-canvas', map.getPane('interp'));
    this.canvas.style.opacity = this.opacity;
    this._reset = this._reset.bind(this);
    this._hide = () => { this.canvas.style.opacity = 0; };
    map.on('movestart zoomstart', this._hide);
    map.on('moveend zoomend resize', this._reset);
    this._reset();
  },
  onRemove(map) {
    map.off('movestart zoomstart', this._hide);
    map.off('moveend zoomend resize', this._reset);
    this.canvas.remove();
  },
  setOpacity(o) { this.opacity = Math.min(0.85, o * 0.75); if (this.canvas) this.canvas.style.opacity = this.opacity; },
  _reset() {
    const map = this._map, size = map.getSize(), cell = 6;
    const cols = Math.ceil(size.x / cell), rows = Math.ceil(size.y / cell);
    L.DomUtil.setPosition(this.canvas, map.containerPointToLayerPoint([0, 0]));
    this.canvas.width = size.x; this.canvas.height = size.y;
    const off = document.createElement('canvas');
    off.width = cols; off.height = rows;
    const octx = off.getContext('2d'), img = octx.createImageData(cols, rows);
    const lon0 = map.containerPointToLatLng([0, 0]).lng, lon1 = map.containerPointToLatLng([size.x, 0]).lng;
    for (let j = 0; j < rows; j++) {
      const lat = map.containerPointToLatLng([0, (j + 0.5) * cell]).lat;
      for (let i = 0; i < cols; i++) {
        const lon = lon0 + (lon1 - lon0) * ((i + 0.5) * cell) / size.x;
        let sw = 0, sv = 0, near = Infinity;
        for (const p of this.points) {
          const d2 = (p.lat - lat) ** 2 + (p.lon - lon) ** 2;
          if (d2 < near) near = d2;
          const w = 1 / Math.max(d2, 1e-5) ** 1.1;  // IDW, power ≈ 2.2
          sw += w; sv += w * p.v;
        }
        const d = Math.sqrt(near);
        const fade = d < 0.35 ? 1 : Math.max(0, 1 - (d - 0.35) / 0.65);  // fade out 0.35°→1°
        const [r, g, b] = this.ramp(sv / sw);
        const k = (j * cols + i) * 4;
        img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = Math.round(255 * fade);
      }
    }
    octx.putImageData(img, 0, 0);
    const ctx = this.canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, 0, 0, size.x, size.y);
    this.canvas.style.opacity = this.opacity;
  },
});

function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#111827' : '#ffffff';
}

function renderAir() {
  if (!AIR) return;
  const param = $('#airParam').value;
  const sp = AIR_PARAMS[param];
  const pts = AIR.points.filter((p) => !AREA_PROV[S.area] || p.provinsi === AREA_PROV[S.area]);
  const val = (p) => (sp.src === 'air' ? p.air : p.wx)[param];
  const vals = pts.map(val).filter((v) => v !== null && v !== undefined);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const digits = param === 'aerosol_optical_depth' ? 2 : param === 'precipitation' ? 1 : 0;
  const short = (v) => (v === null || v === undefined) ? '–' : Number(v).toLocaleString('id-ID', {maximumFractionDigits: digits, minimumFractionDigits: digits});
  const fmtV = (v) => (v === null || v === undefined) ? '—' : `${Number(v).toLocaleString('id-ID', {maximumFractionDigits: 1})} ${sp.unit}`;
  const spread = $('#airSpread').value;
  const radius = Number(spread) || 0;
  const layers = [];
  if (spread === 'idw') {
    const stations = pts.filter((p) => val(p) !== null && val(p) !== undefined).map((p) => ({lat: p.lat, lon: p.lon, v: val(p)}));
    if (stations.length) layers.push(new InterpLayer(stations, rampFor(param, lo, hi)));
  }
  const pins = pts.map((p) => {
    const v = val(p);
    const color = colorFor(param, v, lo, hi);
    if (radius) {
      layers.push(L.circle([p.lat, p.lon], {pane: 'vectors', radius, color, weight: 1, opacity: .6,
        fillColor: color, fillOpacity: .18, interactive: false}));
    }
    // IQAir-style pin: the value itself, coloured by category.
    const m = L.marker([p.lat, p.lon], {pane: 'markerPane', riseOnHover: true, icon: L.divIcon({className: 'aq-icon',
      html: `<div class="aq-pin" style="background:${color};color:${textOn(color)};--pin:${color}">${short(v)}</div>`,
      iconSize: [36, 36], iconAnchor: [18, 18], popupAnchor: [0, -18]})});
    m.bindTooltip(`<b>${esc(p.name)}</b><br>${esc(sp.label)}: ${esc(fmtV(v))}`, {direction: 'top', offset: [0, -18]});
    m.bindPopup(`<div class="pt"><h4>${esc(p.name)}</h4><div class="coord">${esc(p.provinsi)} · titik pusat wilayah · ${esc(AIR.time || '')} WIB</div><table>
      ${Object.entries(AIR_PARAMS).map(([k, s]) => `<tr><td>${esc(s.label)}</td><td>${esc((() => { const x = (s.src === 'air' ? p.air : p.wx)[k]; return x === null || x === undefined ? '—' : `${Number(x).toLocaleString('id-ID', {maximumFractionDigits: 1})} ${s.unit}`; })())}</td></tr>`).join('')}
      <tr><td>Arah angin (dari)</td><td>${p.wx.wind_direction_10m ?? '—'}°</td></tr></table></div>`);
    m.on('click', () => { S.skipClick = true; });
    layers.push(m);
    return m;
  });
  const legend = (sp.scale
    ? legendCats(`${sp.label} · ${AIR.time || ''}`, sp.scale.map(([max, color, name]) => ({color, label: `${name}${max < 1e8 ? ` (≤ ${max})` : ''}`})))
    : legendGradient(`${sp.label} (${sp.unit || 'indeks'}) · ${AIR.time || ''}`, SEQ.map((c) => c.slice(1)), fmtV(lo), fmtV(hi), '', ''))
    + (radius ? `<div class="ends"><span>Lingkaran = radius ${radius / 1000} km dari titik pantau (ilustrasi jangkauan, bukan batas sebaran polutan)</span></div>` : '')
    + (spread === 'idw' ? '<div class="ends"><span>Gradasi = interpolasi IDW antartitik pantau (perkiraan, bukan pengukuran), memudar jauh dari titik.</span></div>' : '');
  const group = L.layerGroup(layers);
  group.setOpacity = (o) => layers.forEach((l) => l instanceof InterpLayer && l.setOpacity(o));
  setLayer('air', group, {label: `${sp.label} · kab/kota`, color: colorFor(param, hi, lo, hi), legend});
  $('#windBtn').classList.remove('hidden');
  const sorted = [...pts].sort((a, b) => (val(b) ?? -1e9) - (val(a) ?? -1e9));
  $('#airList').innerHTML = `<p class="fine">Pembaruan ${esc(AIR.time || '')} WIB · ${pts.length} kab/kota · urut dari tertinggi</p>
    <div class="kab-list">${sorted.map((p) => `<button type="button" class="kab-row" data-air="${esc(p.name)}">
      <span class="kab-name">${esc(p.name)}<small>${esc(p.provinsi)}</small></span>
      <span class="air-chip" style="background:${colorFor(param, val(p), lo, hi)}"></span><b>${esc(fmtV(val(p)))}</b></button>`).join('')}</div>`;
  $$('[data-air]').forEach((b) => b.onclick = () => {
    const i = pts.findIndex((p) => p.name === b.dataset.air);
    S.map.flyTo([pts[i].lat, pts[i].lon], 10, {duration: .8});
    setTimeout(() => pins[i].openPopup(), 900);
  });
  if ($('#windToggle').checked) renderWind(); else removeLayer('wind');
  syncWindBtn();
}

function syncWindBtn() { $('#windBtn').setAttribute('aria-pressed', String($('#windToggle').checked)); }
function setWind(on) {
  $('#windToggle').checked = on;
  syncWindBtn();
  if (on) { if (AIR) renderWind(); else loadAir(); } else removeLayer('wind');
}

/* ------------------------------------------------- animated wind particles */
const WindLayer = L.Layer.extend({
  initialize(points) {
    // u/v in m/s from Open-Meteo speed (km/h) and meteorological direction (where wind comes FROM).
    this.points = points.filter((p) => p.wx.wind_speed_10m !== undefined && p.wx.wind_direction_10m !== undefined)
      .map((p) => {
        const s = p.wx.wind_speed_10m / 3.6, r = p.wx.wind_direction_10m * Math.PI / 180;
        return {lat: p.lat, lon: p.lon, u: -s * Math.sin(r), v: -s * Math.cos(r)};
      });
  },
  onAdd(map) {
    this._map = map;
    if (!map.getPane('wind')) { map.createPane('wind').style.zIndex = 445; map.getPane('wind').style.pointerEvents = 'none'; }
    this.canvas = L.DomUtil.create('canvas', 'wind-canvas', map.getPane('wind'));
    this.ctx = this.canvas.getContext('2d');
    this._reset = this._reset.bind(this);
    this._pause = () => { cancelAnimationFrame(this.raf); this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); };
    map.on('movestart zoomstart', this._pause);
    map.on('moveend zoomend resize', this._reset);
    this._reset();
  },
  onRemove(map) {
    cancelAnimationFrame(this.raf);
    map.off('movestart zoomstart', this._pause);
    map.off('moveend zoomend resize', this._reset);
    this.canvas.remove();
  },
  setOpacity() {},
  /** Inverse-distance interpolation; returns null far from every station (> ~0.6°). */
  _sample(lat, lon) {
    let su = 0, sv = 0, sw = 0, near = Infinity;
    for (const p of this.points) {
      const d2 = (p.lat - lat) ** 2 + (p.lon - lon) ** 2;
      near = Math.min(near, d2);
      const w = 1 / Math.max(d2, 1e-4);
      su += w * p.u; sv += w * p.v; sw += w;
    }
    return near > 0.36 ? null : [su / sw, sv / sw];
  },
  _reset() {
    const map = this._map, size = map.getSize();
    cancelAnimationFrame(this.raf);
    L.DomUtil.setPosition(this.canvas, map.containerPointToLayerPoint([0, 0]));
    this.canvas.width = size.x; this.canvas.height = size.y;
    // Pre-compute a coarse screen-space vector grid (fast lookups per frame).
    const cell = 24, cols = Math.ceil(size.x / cell) + 1, rows = Math.ceil(size.y / cell) + 1;
    const pxPerSec = 1.2 + Math.max(0, map.getZoom() - 7) * 0.6;  // keep motion readable at any zoom
    this.grid = {cell, cols, rows, data: new Array(cols * rows)};
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const ll = map.containerPointToLatLng([i * cell, j * cell]);
        const uv = this._sample(ll.lat, ll.lng);
        this.grid.data[j * cols + i] = uv && [uv[0] * pxPerSec, -uv[1] * pxPerSec];
      }
    }
    const n = Math.min(2500, Math.round(size.x * size.y / 900));
    this.particles = Array.from({length: n}, () => this._spawn());
    const dark = document.documentElement.dataset.theme === 'dark';
    this.color = dark ? 'rgba(186,230,253,0.85)' : 'rgba(3,105,161,0.75)';
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { this._frame(true); return; }
    const loop = () => { this._frame(); this.raf = requestAnimationFrame(loop); };
    loop();
  },
  _spawn() {
    const {cols, rows, cell} = this.grid;
    return {x: Math.random() * (cols - 1) * cell, y: Math.random() * (rows - 1) * cell, age: Math.floor(Math.random() * 80)};
  },
  _vec(x, y) {
    const {cell, cols, data} = this.grid;
    return data[Math.round(y / cell) * cols + Math.round(x / cell)];
  },
  _frame(still = false) {
    const ctx = this.ctx, {width: w, height: h} = this.canvas;
    ctx.globalCompositeOperation = 'destination-in';  // fade previous trails
    ctx.fillStyle = 'rgba(0,0,0,0.92)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const p of this.particles) {
      const v = this._vec(p.x, p.y);
      if (!v || p.age++ > 90) { Object.assign(p, this._spawn(), {age: 0}); continue; }
      const nx = p.x + v[0] * (still ? 12 : 1), ny = p.y + v[1] * (still ? 12 : 1);
      ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny);
      p.x = nx; p.y = ny;
      if (nx < 0 || ny < 0 || nx > w || ny > h) Object.assign(p, this._spawn(), {age: 0});
    }
    ctx.stroke();
  },
});

function renderWind() {
  if (!AIR) return;
  const pts = AIR.points.filter((p) => !AREA_PROV[S.area] || p.provinsi === AREA_PROV[S.area]);
  const speeds = pts.map((p) => p.wx.wind_speed_10m).filter((v) => v !== undefined);
  const avg = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null;
  setLayer('wind', new WindLayer(pts), {label: 'Animasi angin 10 m', color: '#0ea5e9', opacity: false,
    legend: `<h5>Angin 10 m · ${esc(AIR.time || '')}</h5><div class="ends"><span>Garis bergerak = arah tiupan angin</span>
      <span>rerata ${avg === null ? '—' : avg.toLocaleString('id-ID', {maximumFractionDigits: 1})} km/j</span></div>`});
}

async function loadAir() {
  const btn = $('#airLoad');
  btn.disabled = true;
  busy(true, 'Mengambil data Open-Meteo…');
  try {
    AIR = await fetchAir();
    renderAir();
  } catch (err) { toast('Data udara gagal dimuat', ' ' + err.message, 'err'); }
  finally { busy(false); btn.disabled = false; }
}

function loadRainfall() {
  if (needEE()) return;
  const spec = S.status.env_layers.rainfall;
  const y = SNAP()?.env_year || S.currentYear - 1;
  const run = () => eeTileLayer('rasterA', `/api/env/map?layer=rainfall&year=${y}&mask=region&area=${S.area}`, {
    pane: 'rasterA', label: `Curah hujan ${y} (CHIRPS)`, color: '#2171b5',
    legend: legendGradient(`Curah hujan ${y} (mm/tahun)`, spec.palette, spec.min, spec.max, '', ''),
  }).catch((err) => toast('Curah hujan gagal dimuat', ' ' + err.message, 'err'));
  run();
  S.reloaders.set('rasterA', run);
}

/* ------------------------------------------------------------------ wiring */
function initLive() {
  $('#fireDate').value = daysAgo(0); $('#fireDate').max = daysAgo(0);
  $('#trueColorDate').value = daysAgo(1); $('#trueColorDate').max = daysAgo(0);
  $('#gibsDate').max = daysAgo(0);
  $('#gibsLayer').innerHTML = Object.entries(GIBS_ATMOS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  const setGibsDate = () => { $('#gibsDate').value = daysAgo(GIBS_ATMOS[$('#gibsLayer').value].lag); };
  $('#gibsLayer').onchange = setGibsDate; setGibsDate();
  $('#airParam').innerHTML = Object.entries(AIR_PARAMS).map(([k, v]) => `<option value="${k}">${esc(v.label)}${v.unit ? ` (${esc(v.unit)})` : ''}</option>`).join('');
  $('#airParam').onchange = renderAir;
  $('#airLoad').onclick = loadAir;
  $('#windToggle').onchange = (e) => setWind(e.target.checked);
  $('#windBtn').onclick = () => setWind(!$('#windToggle').checked);
  $('#airSpread').onchange = renderAir;
  $('#gibsLoad').onclick = loadGibsAtmos;
  $('#fireLoad').onclick = loadFire;
  $('#trueColorToggle').onchange = (e) => toggleTrueColor(e.target.checked);
  $('#trueColorDate').onchange = () => { if ($('#trueColorToggle').checked) toggleTrueColor(true); };
  $('#rainLoad').onclick = loadRainfall;
}
