"""FastAPI serves the dashboard, Earth Engine layers, GBIF biodiversity and built-in vector layers."""
from __future__ import annotations
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import biodiversity, vectors
from .config import ROOT, PROJECT, SCHEDULER_ENABLED, CACHE_DIR, AREAS
from .gee_service import (EarthEngineUnavailable, service, INDICES, ENV_LAYERS, WORLDCOVER,
                          WATER_LAYERS, WATER_AOIS, FIRST_YEAR, ENV_FIRST_YEAR)
from .store import get_stat, put_stat, stat_key

log = logging.getLogger('rrl')
_scheduler = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _scheduler
    if SCHEDULER_ENABLED:
        try:
            from apscheduler.schedulers.background import BackgroundScheduler
            from apscheduler.triggers.cron import CronTrigger
            from .refresh import refresh_monthly
            _scheduler = BackgroundScheduler(timezone='Asia/Jakarta')
            _scheduler.add_job(refresh_monthly, CronTrigger(day=10, hour=4, minute=0,
                               timezone='Asia/Jakarta'), id='refresh_monthly',
                               max_instances=1, coalesce=True, replace_existing=True)
            _scheduler.start()
            log.info('Penjadwal aktif: tanggal 10, pukul 04:00 WIB.')
        except ImportError:
            log.warning('APScheduler belum terpasang, otomatisasi nonaktif.')
    yield
    if _scheduler:
        _scheduler.shutdown(wait=False)


app = FastAPI(title='RRL EnviroWatch API', version='0.2.0', lifespan=lifespan)
app.mount('/static', StaticFiles(directory=str(ROOT / 'frontend')), name='static')


def _handle_error(exc: Exception):
    if isinstance(exc, HTTPException):
        raise exc
    if isinstance(exc, ValueError):
        raise HTTPException(422, str(exc)) from exc
    if isinstance(exc, EarthEngineUnavailable):
        raise HTTPException(503, str(exc)) from exc
    if isinstance(exc, biodiversity.GbifUnavailable):
        raise HTTPException(502, str(exc)) from exc
    log.exception('Request failed')
    raise HTTPException(502, f'Permintaan Earth Engine gagal: {exc}') from exc


@app.get('/')
def index():
    return FileResponse(ROOT / 'frontend' / 'index.html')


@app.get('/api/status')
def status():
    last = None
    try:
        last = json.loads((CACHE_DIR / 'last_refresh.json').read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        pass
    return {
        'ready': service.ready, 'error': service.error if not service.ready else None,
        'project_configured': bool(PROJECT), 'current_year': service.current_year(),
        'first_year': FIRST_YEAR, 'env_first_year': ENV_FIRST_YEAR,
        'areas': {k: v['label'] for k, v in AREAS.items()},
        'indices': INDICES,
        'env_layers': ENV_LAYERS,
        'water_layers': WATER_LAYERS,
        'water_aois': WATER_AOIS,
        'worldcover': [{'code': c, 'label': n, 'color': '#' + p} for c, n, p in WORLDCOVER],
        'scheduler_enabled': bool(_scheduler and _scheduler.running),
        'scheduler_schedule': 'Tanggal 10 setiap bulan, 04.00 WIB',
        'last_refresh': last,
        'data_note': 'Mask hutan = tutupan pohon + mangrove WorldCover 2021, bukan kawasan hutan legal.',
    }


@app.get('/api/boundary')
def boundary(area: str = 'all'):
    try:
        return service.boundary_geojson(area)
    except Exception as exc:
        _handle_error(exc)


# ---------------------------------------------------------------- indices
@app.get('/api/map')
def map_layer(year: int = Query(ge=2000, le=2100), month: int = Query(0, ge=0, le=12),
              index: str = 'ndvi', mask: str = 'trees', area: str = 'all'):
    try:
        return service.map_layer(index, year, month, mask, area)
    except Exception as exc:
        _handle_error(exc)


@app.get('/api/statistics')
def statistics(year: int = Query(ge=2000, le=2100), month: int = Query(0, ge=0, le=12),
               index: str = 'ndvi', mask: str = 'trees', area: str = 'all', force: bool = False):
    try:
        service.period(year, month)
        index, mask, area = service.check_index(index), service.check_mask(mask), service.check_area(area)
        key = stat_key('index', index=index, year=year, month=month, mask=mask, area=area)
        if not force and (cached := get_stat(key)):
            return {**cached, 'from_cache': True}
        data = service.statistics(index, year, month, mask, area)
        put_stat(key, data)
        return {**data, 'from_cache': False}
    except Exception as exc:
        _handle_error(exc)


@app.get('/api/point')
def point(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180),
          year: int = Query(ge=2000, le=2100), month: int = Query(0, ge=0, le=12)):
    try:
        return service.point(lat, lon, year, month)
    except Exception as exc:
        _handle_error(exc)


# ------------------------------------------------------------ environment
@app.get('/api/env/map')
def env_map(layer: str, year: int = Query(ge=2000, le=2100), mask: str = 'region', area: str = 'all'):
    try:
        return service.env_map_layer(layer, year, mask, area)
    except Exception as exc:
        _handle_error(exc)


@app.get('/api/env/statistics')
def env_statistics(layer: str, year: int = Query(ge=2000, le=2100), mask: str = 'region',
                   area: str = 'all', force: bool = False):
    try:
        mask, area = service.check_mask(mask), service.check_area(area)
        key = stat_key('env', layer=layer, year=year, mask=mask, area=area)
        if not force and (cached := get_stat(key)):
            return {**cached, 'from_cache': True}
        data = service.env_statistics(layer, year, mask, area)
        put_stat(key, data)
        return {**data, 'from_cache': False}
    except Exception as exc:
        _handle_error(exc)


# ---------------------------------------------------------- water quality
@app.get('/api/water/map')
def water_map(layer: str, year: int = Query(ge=2000, le=2100), month: int = Query(0, ge=0, le=12),
              area: str = 'all'):
    try:
        return service.water_map_layer(layer, year, month, area)
    except Exception as exc:
        _handle_error(exc)


@app.get('/api/water/statistics')
def water_statistics(layer: str, year: int = Query(ge=2000, le=2100), month: int = Query(0, ge=0, le=12),
                     area: str = 'all', aoi: str = 'all', force: bool = False):
    try:
        service.check_water(layer, aoi)
        area = service.check_area(area)
        key = stat_key('water', layer=layer, year=year, month=month, area=area, aoi=aoi)
        if not force and (cached := get_stat(key)):
            return {**cached, 'from_cache': True}
        data = service.water_statistics(layer, year, month, area, aoi)
        put_stat(key, data)
        return {**data, 'from_cache': False}
    except Exception as exc:
        _handle_error(exc)


# ----------------------------------------------------------- biodiversity
@app.get('/api/biodiversity/{group}')
def biodiversity_group(group: str, area: str = 'all', refresh: bool = False):
    try:
        return biodiversity.get_group(group, area, refresh)
    except Exception as exc:
        _handle_error(exc)


# ------------------------------------------------- built-in vector layers
@app.get('/api/layers')
def list_layers():
    return vectors.catalog()


@app.get('/api/layers/{kind}')
def get_layer(kind: str):
    try:
        return vectors.load(kind)
    except Exception as exc:
        _handle_error(exc)
