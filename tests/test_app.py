import json
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app import vectors
from app.main import app
from app.gee_service import EarthEngineService, service, INDICES

client = TestClient(app)


def test_home_serves_dashboard():
    response = client.get('/')
    assert response.status_code == 200
    assert 'EnviroWatch' in response.text


def test_status_is_honest_and_describes_layers():
    data = client.get('/api/status').json()
    assert data['ready'] == service.ready
    assert set(data['indices']) == {'ndvi', 'msarvi', 'ndwi', 'ndbi'}
    assert set(data['areas']) == {'all', 'jabar', 'banten', 'jakarta'}
    assert {'erosivity', 'degradation'} <= set(data['env_layers'])


def test_period_2020_full_year():
    start, end = EarthEngineService.period(2020, 0)
    assert (start.isoformat(), end.isoformat()) == ('2020-01-01', '2021-01-01')


def test_future_month_fails():
    today = datetime.now(ZoneInfo('Asia/Jakarta'))
    with pytest.raises(ValueError):
        EarthEngineService.period(today.year, today.month)


def test_validators():
    assert EarthEngineService.check_mask('province') == 'region'
    for bad in [lambda: EarthEngineService.check_index('evi'),
                lambda: EarthEngineService.check_area('jateng'),
                lambda: EarthEngineService.check_mask('x')]:
        with pytest.raises(ValueError):
            bad()


def test_invalid_year_rejected():
    assert client.get('/api/map?year=2018').status_code == 422


def test_unconnected_ee_returns_error_not_fake_values():
    if service.ready:
        pytest.skip('Earth Engine connected')
    for path in ['/api/map?year=2021&index=msarvi', '/api/statistics?year=2021&index=ndbi',
                 '/api/env/map?layer=erosivity&year=2021', '/api/point?lat=-6.9&lon=107.6&year=2021']:
        assert client.get(path).status_code == 503, path


def test_vector_measure_area_and_length():
    square = {'type': 'Polygon', 'coordinates': [[[107.0, -7.0], [107.1, -7.0], [107.1, -6.9], [107.0, -6.9], [107.0, -7.0]]]}
    assert 115 < vectors.measure(square) < 130          # 0.1 deg square near -7 lat ~ 122 km2
    gc = {'type': 'GeometryCollection', 'geometries': [square, {'type': 'LineString', 'coordinates': [[107, -7], [107, -6.9]]}]}
    assert 115 < vectors.measure(gc) - 11.1 < 130       # polygon + ~11 km line
    assert 10.5 < vectors.measure({'type': 'LineString', 'coordinates': [[107, -7], [107, -6.9]]}) < 11.5


def test_builtin_layers_are_read_only_and_classified():
    for kind in ['kawasan', 'das', 'sungai', 'batas']:
        d = client.get(f'/api/layers/{kind}').json()
        if not d['available']:
            continue
        assert all(f['properties']['_class'] != 'Lainnya' for f in d['geojson']['features']), kind
    assert client.post('/api/layers/kawasan', content=b'{}').status_code == 405
    assert client.get('/api/layers/rahasia').status_code == 422
    kinds = {c['kind'] for c in client.get('/api/layers').json()}
    assert {'kawasan', 'das', 'sungai', 'tegakan'} <= kinds


def test_jakarta_area_supported():
    assert 'jakarta' in client.get('/api/status').json()['areas']


def test_index_specs_complete():
    for spec in INDICES.values():
        assert spec['min'] < spec['max'] and len(spec['palette']) >= 5
