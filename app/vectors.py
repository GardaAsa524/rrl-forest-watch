"""Built-in vector layers (read-only) from the ``data/`` folder.

The files are produced by ``scripts/build_data.py`` from official national
datasets (KLHK forest areas, KLHK watersheds, BIG rivers) clipped to
Jawa Barat, Banten and DKI Jakarta. The website never accepts uploads; to
update a layer, rebuild the file and restart the server.
"""
from __future__ import annotations
import json
import math
import re
from threading import Lock

from .config import DATA_DIR

KINDS = {
    'kawasan': {
        'file': 'kawasan_hutan.geojson',
        'title': 'Fungsi kawasan hutan',
        'geometry': 'polygon',
        'class_field': 'fungsi',
        'detail_field': 'jenis',
        'classes': [
            ('Hutan Konservasi', '#1e3a8a'),
            ('Hutan Lindung', '#0d9488'),
            ('Hutan Produksi Terbatas', '#a3e635'),
            ('Hutan Produksi Tetap', '#65a30d'),
            ('Hutan Produksi Konversi', '#facc15'),
        ],
        'source': 'KLHK · Kawasan Hutan 2023 (SK penetapan per provinsi)',
        'popup': {'jenis': 'Jenis', 'provinsi': 'Provinsi', 'sk_penetapan': 'SK', 'tgl_sk': 'Tanggal SK'},
    },
    'tegakan': {
        'file': 'jenis_tegakan.geojson',
        'title': 'Jenis tanaman / tegakan',
        'geometry': 'polygon',
        'fields': ['jenis', 'JENIS', 'tegakan', 'TEGAKAN', 'kelas_perusahaan', 'KP', 'spesies', 'SPESIES',
                   'jenis_tanaman', 'tanaman', 'TANAMAN', 'keterangan', 'KETERANGAN'],
        'patterns': [
            ('Hutan Pinus', '#15803d', r'pinus|tusam'),
            ('Hutan Jati', '#a16207', r'\bjati\b|tectona'),
            ('Hutan Mahoni', '#9a3412', r'mahoni|swietenia'),
            ('Hutan Damar / Agathis', '#0f766e', r'damar|agathis'),
            ('Hutan Rasamala', '#4d7c0f', r'rasamala|altingia'),
            ('Hutan Sengon / Albasia', '#84cc16', r'sengon|albasia|falcataria|paraserianthes'),
            ('Hutan Kayu Putih', '#a8a29e', r'kayu\s*putih|melaleuca'),
            ('Hutan Mangrove', '#0e7490', r'mangrove|bakau|rhizophora|avicennia'),
            ('Hutan Alam / Campuran', '#166534', r'alam|campuran|rimba|\bhar\b|kayu\s*lain'),
        ],
        'source': 'Perum Perhutani / survei (belum tersedia)',
        'popup': {},
    },
    'das': {
        'file': 'das.geojson',
        'title': 'Daerah Aliran Sungai (DAS)',
        'geometry': 'polygon',
        'class_field': 'prioritas',
        'name_field': 'nama_das',
        'classes': [('DAS prioritas', '#dc2626'), ('Bukan prioritas', '#2563eb')],
        'source': 'KLHK · Batas DAS se-Indonesia (dipotong ke wilayah pantauan)',
        'popup': {'luas_total_ha': 'Luas DAS total (ha)', 'prioritas': 'Status', 'wilayah_kerja': 'Wilayah kerja'},
    },
    'sungai': {
        'file': 'sungai.geojson',
        'title': 'Sungai (skala 1:250.000)',
        'geometry': 'line',
        'classes': [('Sungai', '#0284c7')],
        'name_field': 'nama',
        'source': 'BIG · Sungai Line 250K (garis tengah sungai)',
        'popup': {},
    },
    'tanah': {
        'file': 'tanah_web.geojson',
        'title': 'Jenis tanah (semi detail)',
        'geometry': 'polygon',
        'class_field': 'kelompok',
        'detail_field': 'jenis',
        'name_field': 'jenis',
        'classes': [
            ('Kambisol', '#e9c46a'), ('Gleisol', '#457b9d'), ('Latosol', '#c1440e'), ('Andosol', '#6b4226'),
            ('Podsolik', '#f4a261'), ('Mediteran', '#d4a373'), ('Litosol', '#adb5bd'), ('Regosol', '#e5d4b5'),
            ('Aluvial', '#8ecae6'), ('Oksisol', '#9c6644'), ('Nitosol', '#bc4749'), ('Grumusol', '#3d405b'),
            ('Renzina', '#ccd5ae'), ('Molisol', '#4a4e2a'), ('Arenosol', '#fefae0'), ('Lahan rusak', '#7f1d1d'),
            ('Gawir', '#6c757d'), ('Pulau kecil', '#90be6d'), ('Permukiman', '#94a3b8'), ('Tubuh air', '#60a5fa'),
            ('Singkapan batuan', '#495057'), ('Bandar udara', '#cbd5e1'), ('Galian/tambang', '#78350f'),
        ],
        'source': 'BBSDLP Kementan · Peta Tanah Semi Detail 1:50.000 (2016)',
        'popup': {'jenis': 'Jenis tanah', 'asosiasi_umum': 'Asosiasi umum', 'luas_km2': 'Luas total jenis ini (km²)'},
    },
    'kabupaten': {
        'file': 'kabupaten.geojson',
        'title': 'Kabupaten / kota',
        'geometry': 'polygon',
        'classes': [('Kabupaten/Kota', '#334155')],
        'name_field': 'nama',
        'source': 'BIG · Batas Kabupaten/Kota PPBW v1; luas kawasan dari Kawasan Hutan KLHK 2023',
        'popup': {'provinsi': 'Provinsi', 'luas_km2': 'Luas wilayah (km²)',
                  'kws_konservasi_km2': 'Hutan konservasi (km²)', 'kws_lindung_km2': 'Hutan lindung (km²)',
                  'kws_hp_km2': 'Hutan produksi tetap (km²)', 'kws_hpt_km2': 'Hutan produksi terbatas (km²)',
                  'kws_total_km2': 'Total kawasan hutan (km²)', 'kws_persen': 'Porsi kawasan hutan (%)'},
    },
    'batas': {
        'file': 'batas_wilayah.geojson',
        'title': 'Batas provinsi',
        'geometry': 'polygon',
        'classes': [('Batas provinsi', '#0b2f29')],
        'name_field': 'name',
        'source': 'FAO GAUL 2025',
        'popup': {},
    },
}

_CACHE: dict[str, tuple[float, dict]] = {}
_LOCK = Lock()


def _check(kind):
    if kind not in KINDS:
        raise ValueError('Lapisan harus salah satu dari: ' + ', '.join(KINDS))
    return KINDS[kind]


def _classify(spec, props):
    if 'class_field' in spec:
        value = props.get(spec['class_field'])
        for label, color in spec['classes']:
            if value == label:
                return label, color
        return (value or 'Lainnya'), '#94a3b8'
    if 'patterns' in spec:
        texts = [props.get(f) for f in spec['fields'] if isinstance(props.get(f), str)] \
            or [v for v in props.values() if isinstance(v, str)]
        joined = ' | '.join(texts).casefold()
        for label, color, pattern in spec['patterns']:
            if re.search(pattern, joined):
                return label, color
        return 'Tidak dikenali', '#94a3b8'
    return spec['classes'][0]


def _ring_area_km2(ring):
    """Spherical polygon area (km²) for lon/lat rings."""
    if len(ring) < 4:
        return 0.0
    r = 6371.0088
    total = 0.0
    for (lon1, lat1, *_), (lon2, lat2, *_) in zip(ring, ring[1:]):
        total += math.radians(lon2 - lon1) * (2 + math.sin(math.radians(lat1)) + math.sin(math.radians(lat2)))
    return abs(total * r * r / 2)


def _line_km(coords):
    r = 6371.0088
    total = 0.0
    for (lon1, lat1, *_), (lon2, lat2, *_) in zip(coords, coords[1:]):
        p1, p2 = math.radians(lat1), math.radians(lat2)
        dl, dp = math.radians(lon2 - lon1), p2 - p1
        a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        total += 2 * r * math.asin(math.sqrt(a))
    return total


def measure(geom):
    """Area (km²) for polygons, length (km) for lines."""
    if not geom:
        return 0.0
    t, c = geom.get('type'), geom.get('coordinates') or []
    if t == 'Polygon':
        c, t = [c], 'MultiPolygon'
    if t == 'MultiPolygon':
        return sum(_ring_area_km2(p[0]) - sum(_ring_area_km2(h) for h in p[1:]) for p in c if p)
    if t == 'LineString':
        return _line_km(c)
    if t == 'MultiLineString':
        return sum(_line_km(l) for l in c)
    if t == 'GeometryCollection':
        return sum(measure(g) for g in geom.get('geometries', []))
    return 0.0


def _build(kind, spec, data):
    is_line = spec['geometry'] == 'line'
    summary = {}
    for f in data['features']:
        props = f.get('properties') or {}
        f['properties'] = props
        label, color = _classify(spec, props)
        props['_class'], props['_color'] = label, color
        if spec.get('name_field'):
            props['_name'] = props.get(spec['name_field'])
        size = measure(f.get('geometry'))
        props['_size'] = round(size, 3)
        s = summary.setdefault(label, {'label': label, 'color': color, 'size': 0.0, 'features': 0})
        s['size'] += size
        s['features'] += 1
    rows = sorted(summary.values(), key=lambda r: -r['size'])
    return {'available': True, 'geojson': data, 'summary': rows,
            'unit': 'km' if is_line else 'km²', 'total': sum(r['size'] for r in rows),
            'features': len(data['features'])}


def load(kind: str):
    spec = _check(kind)
    path = DATA_DIR / spec['file']
    base = {'kind': kind, 'title': spec['title'], 'file': f"data/{spec['file']}",
            'source': spec['source'], 'geometry': spec['geometry'], 'popup': spec.get('popup', {}),
            'legend': [{'label': c[0], 'color': c[1]} for c in spec.get('classes') or spec.get('patterns')]}
    if not path.exists():
        return {**base, 'available': False}
    mtime = path.stat().st_mtime
    with _LOCK:
        hit = _CACHE.get(kind)
        if hit and hit[0] == mtime:
            return {**base, **hit[1]}
    data = json.loads(path.read_text(encoding='utf-8'))
    if data.get('type') != 'FeatureCollection':
        raise ValueError(f'{spec["file"]} bukan GeoJSON FeatureCollection.')
    built = _build(kind, spec, data)
    with _LOCK:
        _CACHE[kind] = (mtime, built)
    return {**base, **built}


def catalog():
    """Lightweight availability list (no geometry) for the overview."""
    out = []
    for kind, spec in KINDS.items():
        path = DATA_DIR / spec['file']
        out.append({'kind': kind, 'title': spec['title'], 'source': spec['source'],
                    'available': path.exists()})
    return out
