"""Bangun lapisan vektor bawaan website dari data dasar nasional.

Memotong data se-Indonesia ke wilayah Jawa Barat, Banten, dan DKI Jakarta,
menyederhanakan geometri agar ringan di browser, lalu menyimpan GeoJSON
(WGS84) ke folder data/. Jalankan ulang bila ada data baru:

    .venv\\Scripts\\python.exe -m pip install -r requirements-data.txt
    .venv\\Scripts\\python.exe scripts\\build_data.py --source "J:\\kuliah\\DATA DASAR\\Vector"

Batas wilayah diambil dari FAO GAUL melalui Earth Engine (harus terhubung).
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

import geopandas as gpd
from shapely.geometry import MultiPolygon, shape

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app.config import DATA_DIR, PROVINCE_CODES  # noqa: E402

# Kode fungsikws KLHK → kelas fungsi utama.
FUNGSI = {
    100100: 'Hutan Lindung',
    100300: 'Hutan Produksi Tetap',
    100400: 'Hutan Produksi Terbatas',
    100500: 'Hutan Produksi Konversi',
}
KONSERVASI = range(100200, 100300)   # KSA/KPA: CA, SM, TN, TWA, Tahura, Taman Buru, perairan
SKIP = {0, 100700}                   # belum terdefinisi, Areal Penggunaan Lain (bukan kawasan hutan)
RIVER_KEEP = {'Garis Tengah Sungai', 'Sungai Satu Garis'}


def polygonal(geom):
    """make_valid can return GeometryCollections; keep only the polygon parts."""
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type in ('Polygon', 'MultiPolygon'):
        return geom
    parts = []
    for g in getattr(geom, 'geoms', []):
        if g.geom_type == 'Polygon':
            parts.append(g)
        elif g.geom_type == 'MultiPolygon':
            parts.extend(g.geoms)
    return MultiPolygon(parts) if parts else None


def clean(series):
    return series.make_valid().apply(polygonal)


def write(gdf: gpd.GeoDataFrame, name: str, precision: int = 5):
    path = DATA_DIR / name
    gdf = gdf[gdf.geometry.notna()]
    gdf = gdf[~gdf.geometry.is_empty]
    path.unlink(missing_ok=True)
    gdf.to_file(path, driver='GeoJSON', COORDINATE_PRECISION=precision)
    print(f'  -> {path.relative_to(ROOT)}: {len(gdf)} fitur, {path.stat().st_size / 1e6:.1f} MB')


def region() -> gpd.GeoDataFrame:
    from app.gee_service import service
    if not service.ready:
        sys.exit('Earth Engine belum terhubung: ' + service.error)
    fc = service.boundary_geojson('all')
    gdf = gpd.GeoDataFrame([f['properties'] for f in fc['features']],
                           geometry=[shape(f['geometry']) for f in fc['features']], crs=4326)
    write(gdf, 'batas_wilayah.geojson')
    return gdf


def kawasan(src: Path, area: gpd.GeoDataFrame):
    gdb = next(src.glob('Kawasan_Hutan*/*.gdb'))
    print(f'Kawasan hutan: {gdb}')
    gdf = gpd.read_file(gdb, engine='pyogrio')
    gdf = gdf[gdf['kode_prov'].isin(PROVINCE_CODES.values())].copy()
    gdf['kode'] = gdf['fungsikws'].fillna(0).astype(int)
    gdf = gdf[~gdf['kode'].isin(SKIP)]
    gdf['fungsi'] = gdf['kode'].map(lambda k: FUNGSI.get(k) or ('Hutan Konservasi' if k in KONSERVASI else 'Lainnya'))
    names = {v: k for k, v in PROVINCE_CODES.items()}
    out = gpd.GeoDataFrame({
        'fungsi': gdf['fungsi'],
        'jenis': gdf['Keterangan'].str.replace('Margastwa', 'Margasatwa'),
        'provinsi': gdf['kode_prov'].map(names),
        'sk_penetapan': gdf['noskkws'].replace('-', None),
        'tgl_sk': gdf['tglskkws'].astype(str).replace({'NaT': None, 'None': None}),
        'kode_fungsi': gdf['kode'],
    }, geometry=clean(clean(gdf.geometry).simplify(0.0002, preserve_topology=True)), crs=4326)
    write(out, 'kawasan_hutan.geojson')


def das(src: Path, area: gpd.GeoDataFrame):
    shp = next(src.glob('Batas DAS*/*.shp'))
    print(f'DAS: {shp}')
    bbox = tuple(area.to_crs(3857).total_bounds)
    gdf = gpd.read_file(shp, bbox=bbox, engine='pyogrio').to_crs(4326)
    gdf['geometry'] = clean(gdf.geometry)
    gdf = gdf[gdf.geometry.notna()]
    mask = area.union_all()
    gdf = gdf[gdf.intersects(mask)].copy()
    gdf['geometry'] = clean(gdf.geometry.intersection(mask))
    gdf = gdf[gdf.geometry.notna()]
    out = gpd.GeoDataFrame({
        'nama_das': gdf['nama_das'].str.strip(),
        'luas_total_ha': gdf['luas_ha'].round(1),
        'prioritas': gdf['prioritas_'].map({1: 'DAS prioritas', 0: 'Bukan prioritas'}).fillna('—'),
        'wilayah_kerja': gdf['wil_kerja'],
    }, geometry=clean(gdf.geometry.simplify(0.0005, preserve_topology=True)), crs=4326)
    out = out[out.geometry.notna()]
    out = out[out.to_crs(32748).area > 1e6]  # buang serpihan < 1 km2 di tepi batas
    write(out, 'das.geojson')


def sungai(src: Path, area: gpd.GeoDataFrame):
    shp = next(src.glob('Sungai*/Sungai Line 250K*.shp'))
    print(f'Sungai: {shp}')
    bbox = tuple(area.to_crs(3857).total_bounds)
    gdf = gpd.read_file(shp, bbox=bbox, engine='pyogrio').to_crs(4326)
    gdf = gdf[gdf['REMARK'].isin(RIVER_KEEP)]
    gdf = gpd.clip(gdf, area.union_all())
    gdf = gdf.explode(index_parts=False)
    gdf = gdf[gdf.geom_type == 'LineString']
    named = gdf['NAMOBJ'].fillna('').str.strip()
    out = gpd.GeoDataFrame({'nama': named.where(named != '', None)},
                           geometry=gdf.geometry.simplify(0.0003), crs=4326)
    write(out, 'sungai.geojson', precision=4)


KWS_FIELDS = {'Hutan Konservasi': 'kws_konservasi_km2', 'Hutan Lindung': 'kws_lindung_km2',
              'Hutan Produksi Tetap': 'kws_hp_km2', 'Hutan Produksi Terbatas': 'kws_hpt_km2',
              'Hutan Produksi Konversi': 'kws_hpk_km2'}


def kabupaten(src: Path):
    """Batas kabupaten/kota BIG + luas tiap fungsi kawasan hutan di dalamnya."""
    shp = next(src.glob('Batas Administratif/Batas Kabupaten*/*.shp'))
    print(f'Kabupaten/kota: {shp}')
    gdf = gpd.read_file(shp, engine='pyogrio', where="WADMPR IN ('Jawa Barat', 'Banten', 'DKI Jakarta')")
    gdf = gdf[gdf['WADMKK'].notna()].copy()
    gdf['geometry'] = clean(gdf.geometry.force_2d())
    gdf = gdf.dissolve(by=['WADMKK', 'WADMPR'], as_index=False)
    utm = gdf.to_crs(32748)
    out = gpd.GeoDataFrame({'nama': gdf['WADMKK'], 'provinsi': gdf['WADMPR'],
                            'luas_km2': (utm.area / 1e6).round(1)}, geometry=gdf.geometry, crs=4326)
    kws_path = DATA_DIR / 'kawasan_hutan.geojson'
    if kws_path.exists():
        kws = gpd.read_file(kws_path).to_crs(32748)
        kws['geometry'] = kws.geometry.make_valid()
        inter = gpd.overlay(utm[['WADMKK', 'geometry']], kws[['fungsi', 'geometry']], how='intersection',
                            keep_geom_type=True)
        inter['km2'] = inter.area / 1e6
        table = inter.pivot_table(index='WADMKK', columns='fungsi', values='km2', aggfunc='sum').fillna(0)
        for fungsi, col in KWS_FIELDS.items():
            out[col] = out['nama'].map(table[fungsi] if fungsi in table else {}).fillna(0).round(1)
        out['kws_total_km2'] = out[list(KWS_FIELDS.values())].sum(axis=1).round(1)
        out['kws_persen'] = (out['kws_total_km2'] / out['luas_km2'] * 100).round(1)
    out['geometry'] = clean(out.geometry.simplify(0.0003, preserve_topology=True))
    write(out, 'kabupaten.geojson')


def tanah(src: Path, area: gpd.GeoDataFrame):
    """Peta tanah semi detail BBSDLP (1:50.000), dipotong & digabung per jenis tanah utama."""
    shp = next(src.glob('SHP JENIS TANAH*/*.shp'))
    print(f'Jenis tanah: {shp} (besar, mohon tunggu)...', flush=True)
    gdf = gpd.read_file(shp, bbox=tuple(area.total_bounds), engine='pyogrio',
                        columns=['jntnh1', 'jntnh2', 'jntnh3', 'kd_sl'])
    print(f'  {len(gdf)} poligon di kotak wilayah', flush=True)
    gdf['geometry'] = clean(gdf.geometry)
    gdf = gdf[gdf.geometry.notna()]
    gdf = gpd.clip(gdf, area.union_all())
    gdf['jenis'] = gdf['jntnh1'].fillna('Tidak teridentifikasi').str.strip()
    gdf['kelompok'] = gdf['jenis'].str.split().str[0].str.capitalize()
    # Dominant association partners per soil type (for the popup).
    assoc = (gdf.assign(a=gdf['jntnh2'].fillna('') + ' / ' + gdf['jntnh3'].fillna(''))
             .groupby('jenis')['a'].agg(lambda x: x.value_counts().index[0].strip(' /')))
    out = gdf.dissolve(by=['kelompok', 'jenis'], as_index=False)[['kelompok', 'jenis', 'geometry']]
    out['asosiasi_umum'] = out['jenis'].map(assoc).replace('', None)
    out['geometry'] = clean(out.geometry.simplify(0.0004, preserve_topology=True))
    out = out[out.geometry.notna()]
    out['luas_km2'] = (out.to_crs(32748).area / 1e6).round(1)
    write(out.sort_values('luas_km2', ascending=False), 'tanah.geojson', precision=4)
    finish_tanah()


# Map units in the BBSDLP legend that are not soil (no erodibility value is assigned to them).
NON_SOIL = {'Permukiman': 'Permukiman', 'Tubuh': 'Tubuh air', 'Bandar': 'Bandar udara',
            'Galian/': 'Galian/tambang', 'Singkapan': 'Singkapan batuan'}
OTHER_UNITS = {'Lahan': 'Lahan rusak', 'Pulau-pulau': 'Pulau kecil', 'Gawir': 'Gawir'}


def finish_tanah():
    """Tidy class names, flag non-soil units, and write a lighter copy for the browser."""
    gdf = gpd.read_file(DATA_DIR / 'tanah.geojson')
    # Accept raw BBSDLP keys and already-renamed values so the step is idempotent.
    gdf['bukan_tanah'] = gdf['kelompok'].isin(set(NON_SOIL) | set(NON_SOIL.values()))
    gdf['kelompok'] = gdf['kelompok'].replace({**NON_SOIL, **OTHER_UNITS})
    write(gdf, 'tanah.geojson', precision=4)  # detailed: Earth Engine upload (scripts/upload_soil_k.py)
    # Light copy for the browser: drop slivers < 0.15 km² (invisible at regional zoom) and simplify more.
    parts = gdf.explode(index_parts=False)
    parts = parts[parts.to_crs(32748).area > 150_000]
    web = parts.dissolve(by=['kelompok', 'jenis'], as_index=False, aggfunc='first')
    web['geometry'] = clean(web.geometry.simplify(0.0015, preserve_topology=True))
    write(web[web.geometry.notna()], 'tanah_web.geojson', precision=4)  # light: website layer
    print(gdf.groupby('kelompok')['luas_km2'].sum().sort_values(ascending=False).round(0).to_string(), flush=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', required=True, help='Folder induk data vektor (berisi Kawasan_Hutan_2023, dst.)')
    ap.add_argument('--only', nargs='*', help='Bangun hanya lapisan tertentu: batas kawasan das sungai kabupaten tanah')
    args = ap.parse_args()
    src = Path(args.source)
    only = set(args.only or ['batas', 'kawasan', 'das', 'sungai', 'kabupaten', 'tanah'])
    area = None
    if only & {'tanah'} and (DATA_DIR / 'batas_wilayah.geojson').exists() and not only & {'batas'}:
        area = gpd.read_file(DATA_DIR / 'batas_wilayah.geojson')  # reuse boundary, no Earth Engine needed
    if only & {'batas', 'das', 'sungai', 'kawasan'} or (area is None and 'tanah' in only):
        print('Batas wilayah (FAO GAUL via Earth Engine)...')
        area = region()
    if 'kawasan' in only:
        kawasan(src, area)
    if 'das' in only:
        das(src, area)
    if 'sungai' in only:
        sungai(src, area)
    if 'kabupaten' in only:
        kabupaten(src)
    if 'tanah' in only:
        tanah(src, area)
    print('Selesai.')
