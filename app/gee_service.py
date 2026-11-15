"""Google Earth Engine computations. All imagery is real, never simulated.

Wilayah: Jawa Barat dan Banten (FAO GAUL). Lapisan yang dihitung:
- Indeks spektral Sentinel-2 SR Harmonized 10 m: NDVI, MSARVI, NDWI, NDBI.
- Erosivitas hujan (faktor R, rumus Lenvain) dari CHIRPS harian.
- Indikasi degradasi lahan: tren linier NDVI MODIS MOD13Q1 250 m.
- Tutupan lahan ESA WorldCover 2021 (konteks, bukan kawasan hutan legal).
"""
from __future__ import annotations
from datetime import date, datetime, timedelta
from threading import RLock
from time import monotonic
from zoneinfo import ZoneInfo

from .config import PROJECT, AREAS

TZ = ZoneInfo('Asia/Jakarta')
LAYER_CACHE_SECONDS = 25 * 60
FIRST_YEAR = 2020          # Sentinel-2 SR coverage used by this app
ENV_FIRST_YEAR = 2001      # CHIRPS / MODIS based layers

try:
    import ee
except ImportError:
    ee = None

INDICES = {
    'ndvi': {
        'label': 'NDVI', 'name': 'Normalized Difference Vegetation Index',
        'formula': '(NIR − Merah) / (NIR + Merah) · B8, B4',
        'meaning': 'Kehijauan/kerapatan vegetasi. Makin tinggi makin hijau.',
        'min': -0.1, 'max': 0.9,
        'palette': ['b73a36', 'e3a249', 'f4dd72', 'a9cf66', '4f9a51', '176641'],
        'low': 'Jarang / terbuka', 'high': 'Vegetasi rapat',
    },
    'msarvi': {
        'label': 'MSARVI', 'name': 'Modified Soil & Atmospherically Resistant Vegetation Index',
        'formula': '(2N+1 − √((2N+1)² − 8(N − RB))) / 2, RB = R − γ(B − R), γ = 1',
        'meaning': 'Vegetasi dengan koreksi pengaruh tanah dan atmosfer (aerosol).',
        'min': -0.1, 'max': 0.8,
        'palette': ['8c510a', 'd8b365', 'f6e8c3', 'c7eae5', '5ab4ac', '01665e'],
        'low': 'Tanah / jarang', 'high': 'Vegetasi rapat',
    },
    'ndwi': {
        'label': 'NDWI', 'name': 'Normalized Difference Water Index (McFeeters)',
        'formula': '(Hijau − NIR) / (Hijau + NIR) · B3, B8',
        'meaning': 'Badan air dan kebasahan permukaan. Nilai > 0 umumnya air.',
        'min': -0.6, 'max': 0.4,
        'palette': ['7f3b08', 'e08214', 'fee0b6', 'd8daeb', '4393c3', '053061'],
        'low': 'Kering / vegetasi', 'high': 'Air terbuka',
    },
    'ndbi': {
        'label': 'NDBI', 'name': 'Normalized Difference Built-up Index',
        'formula': '(SWIR1 − NIR) / (SWIR1 + NIR) · B11, B8',
        'meaning': 'Lahan terbangun / permukaan keras. Nilai > 0 indikasi terbangun.',
        'min': -0.5, 'max': 0.3,
        'palette': ['1a9850', '91cf60', 'f7f7c4', 'fdae61', 'd73027', '67001f'],
        'low': 'Vegetasi', 'high': 'Terbangun',
    },
}

ENV_LAYERS = {
    'erosivity': {
        'label': 'Erosivitas hujan (R)', 'unit': 'R Lenvain / tahun',
        'min': 500, 'max': 4500,
        'palette': ['ffffcc', 'fed976', 'feb24c', 'fd8d3c', 'f03b20', 'bd0026'],
        'classes': [
            {'max': 1500, 'label': 'Rendah', 'color': '#fed976'},
            {'max': 2500, 'label': 'Sedang', 'color': '#feb24c'},
            {'max': 3500, 'label': 'Tinggi', 'color': '#f03b20'},
            {'max': None, 'label': 'Sangat tinggi', 'color': '#bd0026'},
        ],
        'source': 'UCSB-CHG/CHIRPS/DAILY · R bulanan = 2,21 × P(cm)^1,36 (Lenvain)',
    },
    'rainfall': {
        'label': 'Curah hujan', 'unit': 'mm / periode',
        'min': 1000, 'max': 5000,
        'palette': ['f7fbff', 'c6dbef', '6baed6', '2171b5', '08306b'],
        'source': 'UCSB-CHG/CHIRPS/DAILY',
    },
    'degradation': {
        'label': 'Tren NDVI (degradasi lahan)', 'unit': 'ΔNDVI / tahun',
        'min': -0.01, 'max': 0.01,
        'palette': ['a50026', 'f46d43', 'fee08b', 'f7f7f7', 'd9ef8b', '66bd63', '006837'],
        'classes': [
            {'max': -0.003, 'label': 'Indikasi degradasi', 'color': '#d73027'},
            {'max': 0.003, 'label': 'Relatif stabil', 'color': '#f7f7c4'},
            {'max': None, 'label': 'Indikasi perbaikan', 'color': '#1a9850'},
        ],
        'source': 'MODIS/061/MOD13Q1 · kemiringan regresi linier rerata NDVI tahunan',
    },
    'landcover': {
        'label': 'Tutupan lahan WorldCover 2021', 'unit': 'kelas',
        'source': 'ESA/WorldCover/v200',
    },
}

WATER_LAYERS = {
    'turbidity': {
        'label': 'Kekeruhan / TSS', 'unit': 'mg/L (estimasi)',
        'formula': 'TSS = 355,85·ρ / (1 − ρ/0,1728), ρ = reflektans merah B4 (Nechad dkk. 2010); hanya piksel air (MNDWI > 0)',
        'meaning': 'Padatan tersuspensi (lumpur, sedimen). Tinggi = air keruh dari erosi hulu, muara, atau reklamasi. '
                   'Belum dikalibrasi sampel lapangan: gunakan sebagai nilai relatif.',
        'min': 0, 'max': 80,
        'palette': ['08306b', '2171b5', '6baed6', 'c6dbef', 'f6e8c3', 'dfc27d', 'bf812d', '8c510a'],
        'classes': [
            {'max': 15, 'label': 'Rendah (< 15)', 'color': '#2171b5'},
            {'max': 30, 'label': 'Sedang (15–30)', 'color': '#c6dbef'},
            {'max': 60, 'label': 'Tinggi (30–60)', 'color': '#dfc27d'},
            {'max': None, 'label': 'Sangat tinggi (> 60)', 'color': '#8c510a'},
        ],
        'source': 'COPERNICUS/S2_SR_HARMONIZED (10 m)', 'stat_scale': 100, 'stat_scale_aoi': 20, 'first_year': 2020,
    },
    'chlorophyll': {
        'label': 'Klorofil-a (NDCI)', 'unit': 'NDCI',
        'formula': '(Red-edge − Merah) / (Red-edge + Merah) · B5, B4 (Mishra & Mishra 2012)',
        'meaning': 'Indikasi fitoplankton / alga. Tinggi = potensi eutrofikasi (limbah organik, pupuk).',
        'min': -0.2, 'max': 0.3,
        'palette': ['313695', '4575b4', '74add1', 'e0f3f8', 'fee090', 'a6d96a', '1a9850', '006837'],
        'classes': [
            {'max': 0.0, 'label': 'Rendah', 'color': '#4575b4'},
            {'max': 0.1, 'label': 'Sedang', 'color': '#fee090'},
            {'max': 0.2, 'label': 'Tinggi', 'color': '#a6d96a'},
            {'max': None, 'label': 'Sangat tinggi (bloom)', 'color': '#006837'},
        ],
        'source': 'COPERNICUS/S2_SR_HARMONIZED (20 m red-edge)', 'stat_scale': 100, 'stat_scale_aoi': 20, 'first_year': 2020,
    },
    'sst': {
        'label': 'Suhu permukaan air', 'unit': '°C',
        'formula': 'Landsat 8/9 Collection 2 surface temperature (ST_B10), median periode, piksel air (MNDWI > 0)',
        'meaning': 'Area air yang jauh lebih hangat dari sekitarnya dapat menandai buangan air panas '
                   '(PLTU, industri) atau perairan dangkal/tertutup. Resolusi termal asli 100 m.',
        'min': 26, 'max': 36,
        'palette': ['313695', '4575b4', '74add1', 'ffffbf', 'fdae61', 'f46d43', 'a50026'],
        'source': 'LANDSAT/LC08 + LC09 C02 T1_L2 (ST_B10)', 'stat_scale': 100, 'stat_scale_aoi': 30, 'first_year': 2020,
    },
    'oil': {
        'label': 'Bercak gelap radar (indikasi minyak)', 'unit': '% akuisisi',
        'formula': 'Sentinel-1 VV: piksel ≥ 6 dB lebih gelap dari laut sekitar (median 2 km) dan < −18 dB; nilai = % akuisisi yang gelap',
        'meaning': 'Lapisan minyak meredam gelombang sehingga tampak gelap di radar. Bercak jarang/sesaat '
                   'patut dicek; bercak sering biasanya angin lemah, perairan terlindung, atau look-alike.',
        'min': 1, 'max': 40,
        'palette': ['fff5eb', 'fdd0a2', 'fd8d3c', 'd94801', '7f2704', '000000'],
        'classes': [
            {'max': 0.001, 'label': 'Tidak ada bercak', 'color': '#e0f2fe'},
            {'max': 34, 'label': 'Sesekali (≤ 1/3 citra) · cek kemungkinan tumpahan', 'color': '#fd8d3c'},
            {'max': None, 'label': 'Berulang (> 1/3 citra) · umumnya perairan tenang/look-alike', 'color': '#7f2704'},
        ],
        'source': 'COPERNICUS/S1_GRD (IW, VV)', 'stat_scale': 400, 'stat_scale_aoi': 40, 'monthly_only': True, 'first_year': 2020,
    },
}

# Kotak area fokus (lon/lat WGS84), dipakai untuk statistik & zoom.
WATER_AOIS = {
    'teluk-jakarta': {'label': 'Teluk Jakarta', 'bbox': [106.68, -6.11, 107.03, -5.90]},
    'muara-citarum': {'label': 'Muara Citarum (Muara Gembong)', 'bbox': [107.00, -6.02, 107.18, -5.88]},
    'teluk-banten': {'label': 'Teluk Banten', 'bbox': [106.05, -6.04, 106.30, -5.88]},
    'pesisir-cilegon': {'label': 'Pesisir Cilegon–Merak (Selat Sunda)', 'bbox': [105.86, -6.12, 106.02, -5.88]},
    'jatiluhur': {'label': 'Waduk Jatiluhur', 'bbox': [107.30, -6.62, 107.45, -6.48]},
    'cirata': {'label': 'Waduk Cirata', 'bbox': [107.24, -6.80, 107.40, -6.66]},
    'saguling': {'label': 'Waduk Saguling', 'bbox': [107.30, -6.96, 107.45, -6.83]},
    'palabuhanratu': {'label': 'Teluk Palabuhanratu', 'bbox': [106.35, -7.08, 106.58, -6.95]},
}

WORLDCOVER = [
    (10, 'Tutupan pohon', '006400'), (20, 'Semak', 'ffbb22'), (30, 'Padang rumput', 'ffff4c'),
    (40, 'Lahan pertanian', 'f096ff'), (50, 'Terbangun', 'fa0000'), (60, 'Lahan terbuka', 'b4b4b4'),
    (70, 'Salju/es', 'f0f0f0'), (80, 'Badan air', '0064c8'), (90, 'Lahan basah', '0096a0'),
    (95, 'Mangrove', '00cf75'), (100, 'Lumut/liken', 'fae6a0'),
]


class EarthEngineUnavailable(RuntimeError):
    pass


def _add_month(d: date) -> date:
    return date(d.year + (d.month == 12), d.month % 12 + 1, 1)


class EarthEngineService:
    def __init__(self):
        self.ready = False
        self.error = ''
        self._lock = RLock()
        self._tile_cache = {}
        self._regions = {}
        self._memo = {}
        self._attempt_init()

    # ------------------------------------------------------------------ setup
    def _attempt_init(self):
        if not PROJECT:
            self.error = 'GOOGLE_CLOUD_PROJECT belum diisi pada .env.'
            return
        if ee is None:
            self.error = 'Library earthengine-api belum terpasang. Jalankan pip install -r requirements.txt.'
            return
        try:
            ee.Initialize(project=PROJECT)
            ee.Number(1).getInfo()  # authenticated server check; no fake-ready state
            self.ready = True
            self.error = ''
        except Exception as exc:
            self.error = f'Koneksi Google Earth Engine belum berhasil: {exc}'

    def require_ready(self):
        if not self.ready:
            raise EarthEngineUnavailable(self.error)

    def _remember(self, key, seconds, fn):
        with self._lock:
            hit = self._memo.get(key)
            if hit and monotonic() - hit[0] < seconds:
                return hit[1]
        value = fn()
        with self._lock:
            self._memo[key] = (monotonic(), value)
        return value

    # ---------------------------------------------------------------- periods
    @staticmethod
    def current_year():
        return datetime.now(TZ).year

    @staticmethod
    def period(year: int, month: int = 0, first_year: int = FIRST_YEAR):
        """Only complete calendar months are used; no future/incomplete month."""
        today = datetime.now(TZ).date()
        last_complete_end = date(today.year, today.month, 1)  # exclusive
        if not first_year <= year <= today.year:
            raise ValueError(f'Tahun harus antara {first_year} dan {today.year}.')
        if not 0 <= month <= 12:
            raise ValueError('Bulan harus 0 (tahunan) atau 1–12.')
        if month:
            start = date(year, month, 1)
            end = _add_month(start)
        else:
            start, end = date(year, 1, 1), date(year + 1, 1, 1)
        if end > last_complete_end:
            if month:
                raise ValueError('Bulan ini belum selesai. Pilih bulan terakhir yang lengkap.')
            end = last_complete_end
        if end <= start:
            raise ValueError('Belum ada bulan lengkap untuk periode tersebut.')
        return start, end

    @staticmethod
    def check_area(area: str):
        if area not in AREAS:
            raise ValueError('Area harus salah satu dari: ' + ', '.join(AREAS))
        return area

    @staticmethod
    def check_mask(mask: str):
        if mask == 'province':  # nama lama, tetap diterima
            mask = 'region'
        if mask not in ('trees', 'region'):
            raise ValueError('Mask harus trees atau region.')
        return mask

    @staticmethod
    def check_index(index: str):
        if index not in INDICES:
            raise ValueError('Indeks harus salah satu dari: ' + ', '.join(INDICES))
        return index

    # ----------------------------------------------------------------- region
    def region(self, area: str = 'all'):
        """Province geometry from FAO GAUL 2025 (fallback GAUL 2015)."""
        self.require_ready()
        self.check_area(area)
        if area in self._regions:
            return self._regions[area]
        wanted = {p.casefold() for p in AREAS[area]['provinces']}
        aliases = {'west java': 'jawa barat'}
        choices = [
            ('FAO/GAUL_SIMPLIFIED_500m/2025/level1', 'ISO3_CODE', 'IDN', 'GAUL1_NAME'),
            ('FAO/GAUL/2015/level1', 'ADM0_NAME', 'Indonesia', 'ADM1_NAME'),
        ]
        problems = []
        for asset, country_field, country_value, province_field in choices:
            try:
                provinces = ee.FeatureCollection(asset).filter(ee.Filter.eq(country_field, country_value))
                names = provinces.aggregate_array(province_field).distinct().getInfo() or []
                matching = [n for n in names if isinstance(n, str)
                            and aliases.get(n.strip().casefold(), n.strip().casefold()) in wanted]
                if len(matching) == len(wanted):
                    geom = provinces.filter(ee.Filter.inList(province_field, matching)).union(100).geometry()
                    self._regions[area] = geom
                    return geom
                problems.append(f'{asset}: hanya menemukan {matching}')
            except Exception as exc:
                problems.append(f'{asset}: {exc}')
        raise EarthEngineUnavailable('Batas provinsi tidak ditemukan. ' + '; '.join(problems))

    def boundary_geojson(self, area: str = 'all'):
        self.require_ready()
        out = []
        provinces = AREAS[self.check_area(area)]['provinces']
        keys = {'Jawa Barat': 'jabar', 'Banten': 'banten', 'DKI Jakarta': 'jakarta'}
        for name in provinces:
            geom = self._polygons_only(self.region(keys[name]).simplify(maxError=300).getInfo())
            out.append({'type': 'Feature', 'properties': {'name': name, 'source': 'FAO GAUL'},
                        'geometry': geom})
        return {'type': 'FeatureCollection', 'features': out}

    @staticmethod
    def _polygons_only(geom):
        """Simplified unions can hold points/lines for tiny islands; keep polygons only."""
        polys = []

        def walk(g):
            t = g.get('type')
            if t == 'Polygon':
                polys.append(g['coordinates'])
            elif t == 'MultiPolygon':
                polys.extend(g['coordinates'])
            elif t == 'GeometryCollection':
                for sub in g.get('geometries', []):
                    walk(sub)
        walk(geom or {})
        return {'type': 'MultiPolygon', 'coordinates': polys}

    def forest_mask(self):
        """Fixed WorldCover 2021 tree cover (10) + mangrove (95) footprint."""
        self.require_ready()
        cover = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map')
        return cover.eq(10).Or(cover.eq(95)).selfMask()

    def _apply_mask(self, image, mask, area):
        mask = self.check_mask(mask)
        if mask == 'trees':
            image = image.updateMask(self.forest_mask())
        return image.clip(self.region(area))

    # ------------------------------------------------------- spectral indices
    def s2_composite(self, year: int, month: int, area: str):
        start, end = self.period(year, month)
        region = self.region(area)
        scenes = (ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
                  .filterBounds(region)
                  .filterDate(start.isoformat(), end.isoformat())
                  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 85)))

        def prep(image):
            scl = image.select('SCL')
            # Keep vegetation (4), bare soil (5), water (6); drop cloud/shadow/unclassified.
            good = scl.eq(4).Or(scl.eq(5)).Or(scl.eq(6))
            return image.select(['B2', 'B3', 'B4', 'B8', 'B11']).divide(10000).updateMask(good)

        return scenes.map(prep).median()

    @staticmethod
    def indices_from(comp):
        ndvi = comp.normalizedDifference(['B8', 'B4']).rename('ndvi')
        ndwi = comp.normalizedDifference(['B3', 'B8']).rename('ndwi')
        ndbi = comp.normalizedDifference(['B11', 'B8']).rename('ndbi')
        msarvi = comp.expression(
            '(2*N + 1 - sqrt((2*N + 1)**2 - 8*(N - (R - G*(B - R))))) / 2',
            {'N': comp.select('B8'), 'R': comp.select('B4'), 'B': comp.select('B2'), 'G': 1.0},
        ).rename('msarvi')
        return ee.Image.cat([ndvi, msarvi, ndwi, ndbi])

    def index_image(self, index: str, year: int, month: int = 0, mask: str = 'trees', area: str = 'all'):
        self.require_ready()
        index = self.check_index(index)
        comp = self.s2_composite(year, month, area)
        return self._apply_mask(self.indices_from(comp).select(index), mask, area)

    # ------------------------------------------------------- environment layers
    def _chirps(self):
        return ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')

    def chirps_last_date(self) -> date:
        def fetch():
            ms = self._chirps().filterDate((datetime.now(TZ).date() - timedelta(days=400)).isoformat(),
                                           '2100-01-01').aggregate_max('system:time_start').getInfo()
            return datetime.fromtimestamp(ms / 1000, TZ).date()
        return self._remember('chirps_last', 6 * 3600, fetch)

    def rain_months(self, year: int):
        """Complete months in `year` that CHIRPS fully covers."""
        start, end = self.period(year, 0, ENV_FIRST_YEAR)
        last = self.chirps_last_date()
        months, m = [], start
        while m < end:
            nxt = _add_month(m)
            if nxt - timedelta(days=1) <= last:
                months.append(m)
            m = nxt
        if not months:
            raise ValueError(f'Data CHIRPS {year} belum tersedia (data terakhir {last.isoformat()}).')
        return months

    def erosivity_image(self, year: int):
        months = self.rain_months(year)
        chirps = self._chirps()
        monthly = []
        for m in months:
            p_cm = chirps.filterDate(m.isoformat(), _add_month(m).isoformat()).sum().divide(10)
            monthly.append(p_cm.pow(1.36).multiply(2.21))
        r = ee.ImageCollection.fromImages(monthly).sum().rename('erosivity')
        rain = chirps.filterDate(months[0].isoformat(), _add_month(months[-1]).isoformat()) \
            .sum().rename('rainfall')
        return r.addBands(rain), months

    def degradation_image(self, end_year: int | None = None, start_year: int = ENV_FIRST_YEAR):
        last_full = self.current_year() - 1
        end_year = min(end_year or last_full, last_full)
        if end_year - start_year < 4:
            raise ValueError('Rentang tren minimal 5 tahun.')
        coll = ee.ImageCollection('MODIS/061/MOD13Q1')

        def annual(y):
            y = ee.Number(y)
            imgs = coll.filter(ee.Filter.calendarRange(y, y, 'year')).map(
                lambda i: i.select('NDVI').multiply(0.0001)
                .updateMask(i.select('SummaryQA').lte(1)))
            return ee.Image.constant(y).float().rename('t') \
                .addBands(imgs.mean().rename('ndvi').float())

        stack = ee.ImageCollection.fromImages(ee.List.sequence(start_year, end_year).map(annual))
        slope = stack.select(['t', 'ndvi']).reduce(ee.Reducer.linearFit()).select('scale')
        return slope.rename('degradation'), (start_year, end_year)

    @staticmethod
    def classify(image, classes):
        """Return integer class image 1..n from ascending thresholds."""
        out = ee.Image(len(classes)).updateMask(image.mask())
        for i, c in reversed(list(enumerate(classes))):
            if c['max'] is not None:
                out = out.where(image.lt(c['max']), i + 1)
        return out.rename('class')

    def env_image(self, layer: str, year: int, mask: str, area: str):
        self.require_ready()
        if layer in ('erosivity', 'rainfall'):
            img, months = self.erosivity_image(year)
            meta = {'start': months[0].isoformat(),
                    'end_inclusive': (_add_month(months[-1]) - timedelta(days=1)).isoformat(),
                    'months': len(months), 'partial_year': len(months) < 12}
            img = img.select(layer)
        elif layer == 'degradation':
            img, (y0, y1) = self.degradation_image(year)
            meta = {'trend_start_year': y0, 'trend_end_year': y1}
        elif layer == 'landcover':
            img = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map').rename('landcover')
            meta = {'year': 2021}
        else:
            raise ValueError('Layer harus erosivity, rainfall, degradation, atau landcover.')
        return self._apply_mask(img, mask, area), meta

    # ------------------------------------------------------------- map tiles
    def _tiles(self, key, build):
        with self._lock:
            cached = self._tile_cache.get(key)
            if cached and monotonic() - cached['created'] < LAYER_CACHE_SECONDS:
                return cached['response']
        response = build()
        with self._lock:
            self._tile_cache[key] = {'created': monotonic(), 'response': response}
        return response

    def map_layer(self, index: str, year: int, month: int = 0, mask: str = 'trees', area: str = 'all'):
        index, mask, area = self.check_index(index), self.check_mask(mask), self.check_area(area)
        start, end = self.period(year, month)
        self.require_ready()

        def build():
            spec = INDICES[index]
            image = self.index_image(index, year, month, mask, area)
            mapid = image.getMapId({'min': spec['min'], 'max': spec['max'], 'palette': spec['palette']})
            return {
                'layer': index, 'year': year, 'month': month, 'mask': mask, 'area': area,
                'start': start.isoformat(), 'end_inclusive': (end - timedelta(days=1)).isoformat(),
                'partial_year': month == 0 and end < date(year + 1, 1, 1),
                'tiles': mapid['tile_fetcher'].url_format,
                'source': 'COPERNICUS/S2_SR_HARMONIZED',
            }
        return self._tiles(('idx', index, year, month, mask, area), build)

    def env_map_layer(self, layer: str, year: int, mask: str = 'region', area: str = 'all'):
        self.require_ready()
        mask, area = self.check_mask(mask), self.check_area(area)

        def build():
            image, meta = self.env_image(layer, year, mask, area)
            if layer == 'landcover':
                codes = [c for c, _, _ in WORLDCOVER]
                remapped = image.remap(codes, list(range(len(codes))))
                vis = {'min': 0, 'max': len(codes) - 1, 'palette': [p for _, _, p in WORLDCOVER]}
                mapid = remapped.getMapId(vis)
            else:
                spec = ENV_LAYERS[layer]
                mapid = image.getMapId({'min': spec['min'], 'max': spec['max'], 'palette': spec['palette']})
            return {'layer': layer, 'year': year, 'mask': mask, 'area': area,
                    'tiles': mapid['tile_fetcher'].url_format,
                    'source': ENV_LAYERS[layer]['source'], **meta}
        return self._tiles(('env', layer, year, mask, area), build)

    # ------------------------------------------------------------- statistics
    def statistics(self, index: str, year: int, month: int = 0, mask: str = 'trees', area: str = 'all'):
        self.require_ready()
        index, mask, area = self.check_index(index), self.check_mask(mask), self.check_area(area)
        img = self.index_image(index, year, month, mask, area)
        reducer = ee.Reducer.mean().combine(ee.Reducer.percentile([10, 90]), sharedInputs=True) \
            .combine(ee.Reducer.count(), sharedInputs=True)
        data = img.reduceRegion(reducer=reducer, geometry=self.region(area), scale=250,
                                bestEffort=True, maxPixels=2e8, tileScale=4).getInfo() or {}
        start, end = self.period(year, month)
        return {
            'index': index, 'year': year, 'month': month, 'mask': mask, 'area': area,
            'mean': data.get(f'{index}_mean'), 'p10': data.get(f'{index}_p10'),
            'p90': data.get(f'{index}_p90'), 'valid_samples': data.get(f'{index}_count'),
            'sampling_scale_m': 250,
            'start': start.isoformat(), 'end_inclusive': (end - timedelta(days=1)).isoformat(),
            'partial_year': month == 0 and end < date(year + 1, 1, 1),
        }

    def env_statistics(self, layer: str, year: int, mask: str = 'region', area: str = 'all'):
        self.require_ready()
        if layer not in ('erosivity', 'degradation'):
            raise ValueError('Statistik lingkungan tersedia untuk erosivity dan degradation.')
        mask, area = self.check_mask(mask), self.check_area(area)
        image, meta = self.env_image(layer, year, mask, area)
        classes = ENV_LAYERS[layer]['classes']
        scale = 1000 if layer == 'erosivity' else 250
        cls = self.classify(image, classes)
        reducer = ee.Reducer.mean().combine(ee.Reducer.percentile([10, 90]), sharedInputs=True)
        both = image.rename('v').addBands(cls)
        stats = both.select('v').reduceRegion(reducer, self.region(area), scale, bestEffort=True,
                                              maxPixels=2e8, tileScale=4)
        hist = both.select('class').reduceRegion(ee.Reducer.frequencyHistogram(), self.region(area),
                                                 scale, bestEffort=True, maxPixels=2e8, tileScale=4)
        data = ee.Dictionary({'stats': stats, 'hist': hist.get('class')}).getInfo()
        hist = {int(float(k)): v for k, v in (data.get('hist') or {}).items()}
        total = sum(hist.values()) or 0
        out_classes = []
        for i, c in enumerate(classes, start=1):
            n = hist.get(i, 0)
            out_classes.append({'label': c['label'], 'color': c['color'],
                                'share': (n / total) if total else None,
                                'area_km2': n * (scale / 1000) ** 2})
        s = data.get('stats') or {}
        return {'layer': layer, 'year': year, 'mask': mask, 'area': area,
                'mean': s.get('v_mean'), 'p10': s.get('v_p10'), 'p90': s.get('v_p90'),
                'classes': out_classes, 'sampling_scale_m': scale,
                'unit': ENV_LAYERS[layer]['unit'], **meta}

    # ---------------------------------------------------------- water quality
    @staticmethod
    def check_water(layer: str, aoi: str = 'all'):
        if layer not in WATER_LAYERS:
            raise ValueError('Layer air harus salah satu dari: ' + ', '.join(WATER_LAYERS))
        if aoi != 'all' and aoi not in WATER_AOIS:
            raise ValueError('Area fokus tidak dikenal.')
        return layer

    def water_geom(self, area: str, aoi: str = 'all'):
        """Province land + coastal sea (±12 km), or a preset focus box."""
        if aoi != 'all':
            return ee.Geometry.Rectangle(WATER_AOIS[aoi]['bbox'])
        key = ('water_geom', area)
        if key not in self._regions:
            self._regions[key] = self.region(area).simplify(500).buffer(12000, 200)
        return self._regions[key]

    def land_mask(self):
        """1 on land (province polygons of the whole study area), used to keep sea only."""
        return ee.Image(0).byte().paint(ee.FeatureCollection([ee.Feature(self.region('all'))]), 1)

    def water_image(self, layer: str, year: int, month: int, area: str, aoi: str = 'all', for_stats: bool = False):
        self.require_ready()
        if layer == 'oil' and not month:
            raise ValueError('Deteksi bercak minyak hanya per bulan. Pilih satu bulan.')
        start, end = self.period(year, month, FIRST_YEAR)
        geom = self.water_geom(area, aoi)
        s, e = start.isoformat(), end.isoformat()
        if layer in ('turbidity', 'chlorophyll'):
            def prep(img):
                scl = img.select('SCL')
                good = scl.eq(4).Or(scl.eq(5)).Or(scl.eq(6))  # turbid water is often labelled 5 (soil)
                return img.select(['B3', 'B4', 'B5', 'B11']).divide(10000).updateMask(good)
            comp = (ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED').filterBounds(geom).filterDate(s, e)
                    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 85)).map(prep).median())
            water = comp.normalizedDifference(['B3', 'B11']).gt(0)  # MNDWI > 0 = air
            if layer == 'turbidity':
                red = comp.select('B4')                                # Nechad et al. (2010), 665 nm
                # Formula is only valid well below the saturation reflectance (0.1728);
                # brighter pixels are glint/foam/mixed shoreline, so they are dropped.
                red = red.updateMask(red.gt(0).And(red.lt(0.12)))
                img = red.multiply(355.85).divide(ee.Image(1).subtract(red.divide(0.1728)))
            else:
                img = comp.normalizedDifference(['B5', 'B4'])        # NDCI
            img = img.updateMask(water)
        elif layer == 'sst':
            def prep_l(img):
                qa = img.select('QA_PIXEL')
                clear = qa.bitwiseAnd(1 << 3).eq(0).And(qa.bitwiseAnd(1 << 4).eq(0))  # no cloud / shadow
                st = img.select('ST_B10').multiply(0.00341802).add(149.0).subtract(273.15)
                sr = img.select(['SR_B3', 'SR_B6']).multiply(0.0000275).add(-0.2)
                water = sr.normalizedDifference(['SR_B3', 'SR_B6']).gt(0)
                return st.updateMask(clear.And(water)).rename('v')
            coll = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2').merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'))
            img = coll.filterBounds(geom).filterDate(s, e).map(prep_l).median()
            img = img.updateMask(img.gt(15).And(img.lt(45)))  # drop fill/edge values outside physical range
        elif layer == 'oil':
            scenes = (ee.ImageCollection('COPERNICUS/S1_GRD').filterBounds(geom).filterDate(s, e)
                      .filter(ee.Filter.eq('instrumentMode', 'IW'))
                      .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
                      .select('VV'))
            # Adaptive dark-spot test per acquisition: speckle-smoothed VV must be >= 6 dB darker
            # than the surrounding sea (2 km median) and below -18 dB. Calm-sea areas that are dark
            # everywhere are therefore not flagged; local slicks (oil, but also look-alikes) are.
            def dark_spot(i):
                proj = i.projection()
                smooth = i.reduceResolution(ee.Reducer.mean(), maxPixels=64).reproject(proj.atScale(40))
                # Background at 200 m, then a 2 km neighbourhood mean (cheap at that scale).
                background = (i.reduceResolution(ee.Reducer.mean(), maxPixels=1024).reproject(proj.atScale(200))
                              .focal_mean(2000, 'square', 'meters'))
                return smooth.lt(background.subtract(6)).And(smooth.lt(-18)).rename('dark')
            dark = scenes.map(dark_spot)
            img = dark.mean().multiply(100).updateMask(self.land_mask().eq(0))
            if not for_stats:
                img = img.updateMask(img.gt(0))
        else:
            raise ValueError('Layer air tidak dikenal.')
        meta = {'start': s, 'end_inclusive': (end - timedelta(days=1)).isoformat(),
                'partial_year': month == 0 and end < date(year + 1, 1, 1)}
        if layer == 'oil' and for_stats:
            meta['scenes'] = scenes.size()
        return img.rename('v').clip(geom), meta

    def water_map_layer(self, layer: str, year: int, month: int = 0, area: str = 'all'):
        self.check_water(layer)
        if layer == 'oil' and not month:
            raise ValueError('Deteksi bercak minyak hanya per bulan. Pilih satu bulan.')
        area = self.check_area(area)
        self.period(year, month, FIRST_YEAR)
        self.require_ready()

        def build():
            img, meta = self.water_image(layer, year, month, area)
            spec = WATER_LAYERS[layer]
            mapid = img.getMapId({'min': spec['min'], 'max': spec['max'], 'palette': spec['palette']})
            return {'layer': layer, 'year': year, 'month': month, 'area': area,
                    'tiles': mapid['tile_fetcher'].url_format, 'source': spec['source'], **meta}
        return self._tiles(('water', layer, year, month, area), build)

    def water_statistics(self, layer: str, year: int, month: int = 0, area: str = 'all', aoi: str = 'all'):
        self.check_water(layer, aoi)
        if layer == 'oil' and aoi == 'all':
            raise ValueError('Statistik bercak minyak terlalu berat untuk seluruh pesisir. Pilih satu area fokus.')
        area = self.check_area(area)
        self.require_ready()
        spec = WATER_LAYERS[layer]
        img, meta = self.water_image(layer, year, month, area, aoi, for_stats=True)
        geom = self.water_geom(area, aoi)
        scale = spec['stat_scale'] if aoi == 'all' else spec['stat_scale_aoi']
        reducer = ee.Reducer.mean().combine(ee.Reducer.percentile([10, 90]), sharedInputs=True) \
            .combine(ee.Reducer.count(), sharedInputs=True)
        parts = {'stats': img.reduceRegion(reducer, geom, scale, bestEffort=True, maxPixels=2e8, tileScale=4)}
        if spec.get('classes'):
            parts['hist'] = self.classify(img, spec['classes']).reduceRegion(
                ee.Reducer.frequencyHistogram(), geom, scale, bestEffort=True, maxPixels=2e8, tileScale=4).get('class')
        if 'scenes' in meta:
            parts['scenes'] = meta.pop('scenes')
        data = ee.Dictionary(parts).getInfo()
        if 'scenes' in data:
            meta['scenes'] = data['scenes']
        st = data.get('stats') or {}
        out = {'layer': layer, 'year': year, 'month': month, 'area': area, 'aoi': aoi,
               'mean': st.get('v_mean'), 'p10': st.get('v_p10'), 'p90': st.get('v_p90'),
               'valid_samples': st.get('v_count'), 'sampling_scale_m': scale, 'unit': spec['unit'], **meta}
        if spec.get('classes'):
            hist = {int(float(k)): v for k, v in (data.get('hist') or {}).items()}
            total = sum(hist.values()) or 0
            out['classes'] = [{'label': c['label'], 'color': c['color'],
                               'share': hist.get(i, 0) / total if total else None,
                               'area_km2': hist.get(i, 0) * (scale / 1000) ** 2}
                              for i, c in enumerate(spec['classes'], start=1)]
        return out

    # ------------------------------------------------------------ point query
    def point(self, lat: float, lon: float, year: int, month: int = 0):
        self.require_ready()
        pt = ee.Geometry.Point([lon, lat])
        bands = [self.indices_from(self.s2_composite(year, month, 'all'))]
        rain_year = None
        for y in (year, year - 1):
            try:
                self.rain_months(y)
                rain_year = y
                break
            except ValueError:
                continue
        if rain_year:
            bands.append(self.erosivity_image(rain_year)[0])
        trend, (y0, y1) = self.degradation_image()
        dem = ee.Image('USGS/SRTMGL1_003')
        bands += [trend, dem.rename('elevation'), ee.Terrain.slope(dem).rename('slope'),
                  ee.ImageCollection('ESA/WorldCover/v200').first().select('Map').rename('landcover')]
        values = ee.Image.cat(bands).reduceRegion(ee.Reducer.first(), pt, scale=10).getInfo() or {}
        lc = values.get('landcover')
        lc_label = next((n for c, n, _ in WORLDCOVER if c == lc), None)
        return {'lat': lat, 'lon': lon, 'year': year, 'month': month,
                'indices': {k: values.get(k) for k in INDICES},
                'erosivity': values.get('erosivity'), 'rainfall_mm': values.get('rainfall'),
                'rain_year': rain_year,
                'ndvi_trend_per_year': values.get('degradation'), 'trend_years': [y0, y1],
                'elevation_m': values.get('elevation'), 'slope_deg': values.get('slope'),
                'landcover': lc_label}


service = EarthEngineService()
