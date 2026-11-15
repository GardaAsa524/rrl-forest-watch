"""Biodiversity records from GBIF (https://www.gbif.org), cached locally.

Only real occurrence records are used. Records of threatened animals are
aggregated to a coarse grid before they are sent to the browser, so the site
never publishes exact locations of protected wildlife.
"""
from __future__ import annotations
import json
import math
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from threading import Lock

from .config import CACHE_DIR

GBIF = 'https://api.gbif.org/v1/'
USER_AGENT = 'RRL-EnviroWatch/0.2 (+local web GIS)'
# GADM level-1 ids used by GBIF: IDN.9_1 = Jawa Barat, IDN.4_1 = Banten, IDN.7_1 = DKI Jakarta.
GADM = {'all': ['IDN.9_1', 'IDN.4_1', 'IDN.7_1'], 'jabar': ['IDN.9_1'], 'banten': ['IDN.4_1'],
        'jakarta': ['IDN.7_1']}
CACHE_SECONDS = 7 * 24 * 3600
ANIMAL_GRID_DEG = 0.1      # ~11 km cells for threatened fauna
PLANT_GRID_DEG = 0.05      # ~5.5 km cells for tree species

ANIMALS = [
    {'id': 'badak-jawa', 'name': 'Badak Jawa', 'scientific': 'Rhinoceros sondaicus',
     'query': 'Rhinoceros sondaicus', 'color': '#475569', 'icon': '🦏',
     'habitat': 'Satu-satunya populasi liar di dunia hidup di Taman Nasional Ujung Kulon, Banten: hutan '
                'hujan dataran rendah, rawa, dan kubangan dekat pantai. Sangat rentan bencana (tsunami, '
                'letusan Anak Krakatau) dan penyakit karena populasinya terpusat di satu lokasi.',
     'note': 'Catatan GBIF sangat sedikit karena lokasi badak dirahasiakan. Habitat ditunjukkan dengan '
             'batas TN Ujung Kulon dari data Kawasan Hutan KLHK.',
     # Kawasan TN Ujung Kulon di data kawasan hutan (SK 419/Kpts-II/1999, ujung barat Banten).
     'zone': {'label': 'Taman Nasional Ujung Kulon', 'provinsi': 'Banten', 'jenis': 'Taman Nasional',
              'sk': '419/Kpts-II/1999', 'max_lon': 105.7}},
    {'id': 'macan-tutul', 'name': 'Macan Tutul Jawa', 'scientific': 'Panthera pardus melas',
     'query': 'Panthera pardus', 'iucn_query': 'Panthera pardus melas', 'color': '#c2410c', 'icon': '🐆',
     'habitat': 'Hutan hujan dataran rendah hingga pegunungan, hutan sekunder dan tepi perkebunan. '
                'Predator puncak terakhir di Jawa; membutuhkan bentang hutan yang tersambung.',
     'note': 'Di Jawa hanya terdapat subspesies P. p. melas, jadi catatan Panthera pardus dipakai.'},
    {'id': 'owa-jawa', 'name': 'Owa Jawa', 'scientific': 'Hylobates moloch',
     'query': 'Hylobates moloch', 'color': '#7c3aed', 'icon': '🐒',
     'habitat': 'Endemik Jawa bagian barat. Hidup di tajuk hutan hujan primer dan sekunder tua, '
                'umumnya di bawah ±1.600 mdpl; sangat bergantung pada tajuk yang bersambung.'},
    {'id': 'surili', 'name': 'Surili', 'scientific': 'Presbytis comata',
     'query': 'Presbytis comata', 'color': '#0891b2', 'icon': '🐵',
     'habitat': 'Endemik Jawa bagian barat–tengah. Hutan dataran rendah hingga pegunungan, '
                'termasuk hutan sekunder; pemakan daun muda.'},
    {'id': 'elang-jawa', 'name': 'Elang Jawa', 'scientific': 'Nisaetus bartelsi',
     'query': 'Nisaetus bartelsi', 'color': '#b45309', 'icon': '🦅',
     'habitat': 'Endemik Jawa. Hutan hujan perbukitan dan pegunungan dengan pohon tinggi untuk '
                'bersarang; simbol nasional (Garuda).'},
]

PLANTS = [
    {'id': 'pinus', 'name': 'Pinus', 'scientific': 'Pinus merkusii', 'query': 'Pinus merkusii',
     'color': '#15803d', 'forest': 'Hutan pinus (tanaman Perhutani, dataran tinggi)'},
    {'id': 'jati', 'name': 'Jati', 'scientific': 'Tectona grandis', 'query': 'Tectona grandis',
     'color': '#a16207', 'forest': 'Hutan jati (dataran rendah, musim kering nyata)'},
    {'id': 'mahoni', 'name': 'Mahoni', 'scientific': 'Swietenia macrophylla', 'query': 'Swietenia macrophylla',
     'color': '#9a3412', 'forest': 'Hutan tanaman mahoni'},
    {'id': 'damar', 'name': 'Damar / Agathis', 'scientific': 'Agathis dammara', 'query': 'Agathis dammara',
     'color': '#0f766e', 'forest': 'Hutan damar (getah kopal)'},
    {'id': 'rasamala', 'name': 'Rasamala', 'scientific': 'Altingia excelsa', 'query': 'Altingia excelsa',
     'color': '#4d7c0f', 'forest': 'Hutan alam pegunungan'},
    {'id': 'puspa', 'name': 'Puspa', 'scientific': 'Schima wallichii', 'query': 'Schima wallichii',
     'color': '#65a30d', 'forest': 'Hutan alam pegunungan & sekunder'},
    {'id': 'bakau', 'name': 'Bakau', 'scientific': 'Rhizophora mucronata', 'query': 'Rhizophora mucronata',
     'color': '#0e7490', 'forest': 'Hutan mangrove pesisir'},
]

_LOCK = Lock()


class GbifUnavailable(RuntimeError):
    pass


def _get(path: str, params: dict | list | None = None):
    url = GBIF + path
    if params:
        url += '?' + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=40) as res:
            return json.load(res)
    except Exception as exc:  # network, HTTP or JSON errors
        raise GbifUnavailable(f'GBIF tidak dapat dihubungi: {exc}') from exc


def _taxon(query: str):
    m = _get('species/match', {'name': query})
    key = m.get('acceptedUsageKey') or m.get('usageKey')
    if not key:
        raise GbifUnavailable(f'Takson {query} tidak ditemukan di GBIF.')
    iucn = None
    try:
        r = _get(f'species/{key}/iucnRedListCategory')
        iucn = {'code': r.get('code'), 'category': r.get('category')}
    except GbifUnavailable:
        pass
    return key, iucn


def _occurrences(key: int, area: str, cap: int = 3000):
    records, offset = [], 0
    while offset < cap:
        page = _get('occurrence/search', {
            'taxonKey': key, 'gadmGid': GADM[area], 'hasCoordinate': 'true',
            'hasGeospatialIssue': 'false', 'occurrenceStatus': 'PRESENT',
            'limit': 300, 'offset': offset,
        })
        for r in page.get('results', []):
            if r.get('basisOfRecord') == 'LIVING_SPECIMEN':  # zoos / gardens
                continue
            records.append({'lat': r.get('decimalLatitude'), 'lon': r.get('decimalLongitude'),
                            'year': r.get('year'), 'basis': r.get('basisOfRecord'),
                            'unc': r.get('coordinateUncertaintyInMeters')})
        if page.get('endOfRecords', True):
            break
        offset += 300
    return records


def _grid(records, cell):
    cells = defaultdict(lambda: {'count': 0, 'last_year': None})
    for r in records:
        if r['lat'] is None or r['lon'] is None:
            continue
        i, j = math.floor(r['lat'] / cell), math.floor(r['lon'] / cell)
        c = cells[(i, j)]
        c['count'] += 1
        if r['year'] and (c['last_year'] is None or r['year'] > c['last_year']):
            c['last_year'] = r['year']
    features = []
    for (i, j), c in cells.items():
        s, w = round(i * cell, 4), round(j * cell, 4)
        n, e = round(s + cell, 4), round(w + cell, 4)
        features.append({'type': 'Feature', 'properties': c, 'geometry': {
            'type': 'Polygon', 'coordinates': [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}})
    return {'type': 'FeatureCollection', 'features': features}


def _build(spec: dict, area: str, cell: float):
    key, iucn = _taxon(spec['query'])
    if iucn:
        iucn['scope'] = 'spesies'
    if spec.get('iucn_query'):
        _, sub = _taxon(spec['iucn_query'])
        if sub and sub.get('code'):
            iucn = {**sub, 'scope': 'subspesies'}
        elif iucn:
            iucn['scope'] = 'spesies (status subspesies Jawa tidak tersedia di GBIF; cek iucnredlist.org)'
    records = _occurrences(key, area)
    years = [r['year'] for r in records if r['year']]
    since_2015 = sum(1 for y in years if y >= 2015)
    return {
        **{k: v for k, v in spec.items() if k not in ('query', 'iucn_query')},
        'taxon_key': key, 'iucn': iucn, 'records': len(records),
        'records_since_2015': since_2015,
        'first_year': min(years) if years else None, 'last_year': max(years) if years else None,
        'grid_deg': cell, 'grid': _grid(records, cell),
        'gbif_url': f'https://www.gbif.org/species/{key}',
    }


def get_group(group: str, area: str = 'all', refresh: bool = False):
    if group not in ('animals', 'plants'):
        raise ValueError('Kelompok harus animals atau plants.')
    if area not in GADM:
        raise ValueError('Area harus all, jabar, banten, atau jakarta.')
    path = CACHE_DIR / f'gbif_{group}_{area}.json'
    with _LOCK:
        if not refresh:
            try:
                cached = json.loads(path.read_text(encoding='utf-8'))
                if time.time() - cached['fetched'] < CACHE_SECONDS:
                    return {**cached, 'from_cache': True}
            except (OSError, ValueError, KeyError):
                pass
        specs, cell = (ANIMALS, ANIMAL_GRID_DEG) if group == 'animals' else (PLANTS, PLANT_GRID_DEG)
        try:
            items = [_build(s, area, cell) for s in specs]
        except GbifUnavailable:
            # Serve stale cache rather than nothing, but say so.
            try:
                stale = json.loads(path.read_text(encoding='utf-8'))
                return {**stale, 'from_cache': True, 'stale': True}
            except (OSError, ValueError):
                raise
        data = {'group': group, 'area': area, 'fetched': time.time(), 'species': items,
                'source': 'GBIF.org occurrence API', 'license_note':
                'Setiap catatan memiliki lisensi dataset masing-masing (CC0 / CC BY / CC BY-NC).'}
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        tmp.replace(path)
        return {**data, 'from_cache': False}
