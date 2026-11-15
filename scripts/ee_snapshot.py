"""Earth Engine snapshot for the static (GitHub Pages) build.

Renders map overlays (PNG, Web Mercator) and statistics JSON for a fixed set
of periods so the static site can show Earth Engine results without a server.
Used by scripts/build_static.py --with-ee (locally or in GitHub Actions).

File layout (all under docs/api/):
  maps/index_<index>_<year>_<month>_<mask>.json   {+ .png}
  maps/env_<layer>_<year>_<mask>.json             {+ .png}
  maps/water_<layer>_<year>_<month>.json          {+ .png}
  stats/index_<index>_<year>_<month>_<mask>_<area>.json
  stats/env_<layer>_<year>_<mask>_<area>.json
  stats/water_<layer>_<year>_<month>_<area>_<aoi>.json
"""
from __future__ import annotations
import json
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import ee

from app.gee_service import (ENV_LAYERS, INDICES, TZ, WATER_AOIS, WATER_LAYERS, WORLDCOVER, service)

TILE_PX = 1024   # per tile; one request per tile keeps Earth Engine under its thumbnail limits
GRID = 2         # 2 x 2 tiles -> 2048 px across the study area (±200 m)
# Projects in Earth Engine "Restricted Mode" (noncommercial, unverified) get a very low
# concurrency limit, so keep parallel requests small and back off on HTTP 429.
WORKERS = 3


def _dump(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'), default=str), encoding='utf-8')


def _retry(fn, tries=6):
    for i in range(tries):
        try:
            return fn()
        except Exception as exc:
            if i == tries - 1:
                raise
            busy = '429' in str(exc) or 'Too Many Requests' in str(exc) or 'concurrency' in str(exc)
            time.sleep(20 * 2 ** i if busy else 5 * (i + 1))  # 429: 20, 40, 80 s ...


class Snapshot:
    def __init__(self, docs: Path):
        self.api = docs / 'api'
        self.jobs = []
        self.done, self.failed = 0, []
        self._lock = threading.Lock()
        geom = service.water_geom('all')  # provinces + coastal sea: superset for every overlay
        ring = geom.bounds().coordinates().get(0).getInfo()
        lons, lats = [p[0] for p in ring], [p[1] for p in ring]
        self.bbox = [min(lons), min(lats), max(lons), max(lats)]
        self.region = ee.Geometry.Rectangle(self.bbox)
        self.bounds = [[self.bbox[1], self.bbox[0]], [self.bbox[3], self.bbox[2]]]

    # ------------------------------------------------------------- jobs
    def tiles(self):
        w, s_, e, n = self.bbox
        dx, dy = (e - w) / GRID, (n - s_) / GRID
        for i in range(GRID):
            for j in range(GRID):
                yield i, j, [w + i * dx, s_ + j * dy, w + (i + 1) * dx, s_ + (j + 1) * dy]

    def map_job(self, name: str, build, meta: dict):
        """One job per tile so every Earth Engine request stays small; the JSON is written
        once all tiles of a map exist."""
        out = self.api / 'maps'
        tiles = list(self.tiles())
        holder = {}

        def visual():
            with self._lock:
                if 'img' not in holder:
                    image, vis = build()
                    holder['img'] = image.visualize(**vis)
            return holder['img']

        def tile_job(i, j, box):
            def run():
                url = visual().getThumbURL({'region': ee.Geometry.Rectangle(box), 'dimensions': TILE_PX,
                                            'format': 'png', 'crs': 'EPSG:3857'})
                try:
                    with urllib.request.urlopen(url, timeout=600) as res:
                        data = res.read()
                except urllib.error.HTTPError as exc:  # surface Earth Engine's reason
                    raise RuntimeError(f'{exc} {exc.read()[:200]!r}') from exc
                out.mkdir(parents=True, exist_ok=True)
                (out / f'{name}_{i}{j}.png').write_bytes(data)
                if all((out / f'{name}_{a}{b}.png').exists() for a, b, _ in tiles):
                    _dump(out / f'{name}.json', {
                        **meta, 'snapshot': True, 'bounds': self.bounds,
                        'images': [{'image': f'api/maps/{name}_{a}{b}.png',
                                    'bounds': [[bx[1], bx[0]], [bx[3], bx[2]]]} for a, b, bx in tiles],
                        'resolution_note': f'Snapshot {GRID * TILE_PX} px (±200 m); versi server memakai resolusi penuh.'})
            return run

        for i, j, box in tiles:
            self.jobs.append((f'map {name} [{i}{j}]', tile_job(i, j, box)))

    def stat_job(self, name: str, fn):
        self.jobs.append((f'stat {name}', lambda: _dump(self.api / 'stats' / f'{name}.json', fn())))

    def run(self):
        print(f'  Earth Engine: {len(self.jobs)} pekerjaan, {WORKERS} paralel...', flush=True)
        with ThreadPoolExecutor(WORKERS) as pool:
            futures = {pool.submit(_retry, fn): label for label, fn in self.jobs}
            for fut in as_completed(futures):
                label = futures[fut]
                try:
                    fut.result()
                    self.done += 1
                except Exception as exc:
                    self.failed.append(f'{label}: {str(exc)[:200]}')
                    print(f'  ! {label}: {str(exc)[:200]}', flush=True)
        print(f'  Selesai: {self.done} berhasil, {len(self.failed)} gagal.', flush=True)


def build(docs: Path, only: set[str] | None = None) -> dict:
    """Queue and run every snapshot job; returns the manifest stored in status.json."""
    if not service.ready:
        raise RuntimeError(service.error)
    snap = Snapshot(docs)
    last_full = service.current_year() - 1
    first = 2020
    index_years = list(range(first, last_full + 1))
    map_years = sorted({first, last_full})

    # Spectral indices: maps for first/last year, statistics for every year (trend chart).
    for idx, spec in INDICES.items():
        vis = {'min': spec['min'], 'max': spec['max'], 'palette': spec['palette']}
        for mask in ('trees', 'region'):
            for y in map_years:
                snap.map_job(f'index_{idx}_{y}_0_{mask}',
                             lambda idx=idx, y=y, mask=mask, vis=vis: (service.index_image(idx, y, 0, mask, 'all'), vis),
                             {'layer': idx, 'year': y, 'month': 0, 'mask': mask, 'area': 'all',
                              'start': f'{y}-01-01', 'end_inclusive': f'{y}-12-31', 'partial_year': False})
            for y in index_years:
                snap.stat_job(f'index_{idx}_{y}_0_{mask}_all',
                              lambda idx=idx, y=y, mask=mask: service.statistics(idx, y, 0, mask, 'all'))

    # Environment: erosivity / rainfall / degradation for the last full year, land cover 2021.
    for layer in ('erosivity', 'erosion', 'rainfall', 'degradation'):
        spec = ENV_LAYERS[layer]
        vis = {'min': spec['min'], 'max': spec['max'], 'palette': spec['palette']}
        for mask in ('region', 'trees'):
            snap.map_job(f'env_{layer}_{last_full}_{mask}',
                         lambda layer=layer, mask=mask, vis=vis: (service.env_image(layer, last_full, mask, 'all')[0], vis),
                         {'layer': layer, 'year': last_full, 'mask': mask, 'area': 'all', 'source': spec['source']})
            if layer != 'rainfall':
                snap.stat_job(f'env_{layer}_{last_full}_{mask}_all',
                              lambda layer=layer, mask=mask: service.env_statistics(layer, last_full, mask, 'all'))
    # Deforestation (Hansen) & 20-year land conversion (MODIS).
    from app.gee_service import HANSEN_LAST_YEAR, LAND_CHANGE
    fl = ENV_LAYERS['forestloss']
    for mask in ('region', 'trees'):
        snap.map_job(f'env_forestloss_{HANSEN_LAST_YEAR}_{mask}',
                     lambda mask=mask: (service.env_image('forestloss', HANSEN_LAST_YEAR, mask, 'all')[0],
                                        {'min': fl['min'], 'max': fl['max'], 'palette': fl['palette']}),
                     {'layer': 'forestloss', 'year': HANSEN_LAST_YEAR, 'mask': mask, 'area': 'all',
                      'start_year': 2001, 'end_year': HANSEN_LAST_YEAR})
        snap.stat_job(f'forestloss_{mask}_all', lambda mask=mask: service.forest_loss_stats(mask, 'all'))
    snap.map_job('env_landchange_2025_region',
                 lambda: (service.env_image('landchange', 2025, 'region', 'all')[0],
                          {'min': 1, 'max': len(LAND_CHANGE), 'palette': [c.lstrip('#') for _, _, c in LAND_CHANGE]}),
                 {'layer': 'landchange', 'year': 2025, 'mask': 'region', 'area': 'all', 'start_year': 2005, 'end_year': 2025})
    snap.stat_job('landchange_2025_all', lambda: service.land_change_stats(2005, 2025, 'all'))
    codes = [c for c, _, _ in WORLDCOVER]
    lc_vis = {'min': 0, 'max': len(codes) - 1, 'palette': [p for _, _, p in WORLDCOVER]}
    for mask in ('region', 'trees'):
        snap.map_job(f'env_landcover_2021_{mask}',
                     lambda mask=mask: (service.env_image('landcover', 2021, mask, 'all')[0]
                                        .remap(codes, list(range(len(codes)))), lc_vis),
                     {'layer': 'landcover', 'year': 2021, 'mask': mask, 'area': 'all'})

    # Water quality (annual layers only; radar oil detection stays server-only).
    water_layers = [k for k, v in WATER_LAYERS.items() if not v.get('monthly_only')]
    for layer in water_layers:
        spec = WATER_LAYERS[layer]
        vis = {'min': spec['min'], 'max': spec['max'], 'palette': spec['palette']}
        snap.map_job(f'water_{layer}_{last_full}_0',
                     lambda layer=layer, vis=vis: (service.water_image(layer, last_full, 0, 'all')[0], vis),
                     {'layer': layer, 'year': last_full, 'month': 0, 'area': 'all', 'source': spec['source'],
                      'start': f'{last_full}-01-01', 'end_inclusive': f'{last_full}-12-31', 'partial_year': False})
        for aoi in ['all', *WATER_AOIS]:
            snap.stat_job(f'water_{layer}_{last_full}_0_all_{aoi}',
                          lambda layer=layer, aoi=aoi: service.water_statistics(layer, last_full, 0, 'all', aoi))

    if only is not None:
        snap.jobs = [(label, fn) for label, fn in snap.jobs if label.split()[1] in only]
    snap.run()
    return {'generated': datetime.now(TZ).isoformat(timespec='minutes'),
            'index_years': index_years, 'index_map_years': map_years,
            'env_year': last_full, 'water_year': last_full, 'water_layers': water_layers,
            'jobs_ok': snap.done, 'jobs_failed': len(snap.failed),
            'errors': sorted({e.split(': ', 1)[-1][:300] for e in snap.failed})[:5]}
