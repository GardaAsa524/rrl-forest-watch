r"""Unggah peta tanah BBSDLP + nilai K ke Earth Engine untuk model erosi RUSLE.

Peta tanah semi detail berisi NAMA jenis tanah, bukan nilai erodibilitas (K).
Nilai K tiap jenis tanah diisi di data/k_tanah.csv (kolom: jenis, k, sumber)
dari referensi atau hasil laboratorium. Jenis tanah tanpa nilai K tidak diunggah
dan di area itu model memakai K dari tekstur OpenLandMap.

    .venv\Scripts\python.exe scripts\upload_soil_k.py --template   # buat/isi ulang templat CSV
    .venv\Scripts\python.exe scripts\upload_soil_k.py              # unggah ke Earth Engine

Hasil: projects/<project>/assets/envirowatch/tanah_k_<n>, dipakai otomatis oleh
lapisan "Bahaya erosi". Perlu login Earth Engine dengan akun pemilik project.
"""
from __future__ import annotations
import csv
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import ee  # noqa: E402
from app.config import DATA_DIR  # noqa: E402
from app.gee_service import service  # noqa: E402

CHUNK_BYTES = 6_000_000  # keep each export request well under Earth Engine's payload limit


def k_table():
    path = DATA_DIR / 'k_tanah.csv'
    table = {}
    if path.exists():
        with path.open(encoding='utf-8-sig') as f:
            for row in csv.DictReader(f):
                key = (row.get('jenis') or row.get('kelompok') or '').strip().casefold()
                if key and (row.get('k') or '').strip():
                    table[key] = float(row['k'].replace(',', '.'))
        print(f'Tabel K: {len(table)} baris dari {path.name}')
    return table


def write_template():
    """CSV with every soil type in the study area; existing k values are kept."""
    data = json.loads((DATA_DIR / 'tanah.geojson').read_text(encoding='utf-8'))
    old = k_table()
    rows = sorted({(f['properties']['kelompok'], f['properties']['jenis']) for f in data['features']
                   if not f['properties'].get('bukan_tanah')})
    path = DATA_DIR / 'k_tanah.csv'
    with path.open('w', encoding='utf-8', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['kelompok', 'jenis', 'k', 'sumber'])
        for kel, jen in rows:
            w.writerow([kel, jen, old.get(jen.casefold(), ''), ''])
    print(f'Templat {path.name}: {len(rows)} jenis tanah. Isi kolom k (skala Wischmeier, mis. 0,05–0,6) dan sumbernya.')


def main():
    if '--template' in sys.argv:
        write_template(); return
    if not service.ready:
        sys.exit('Earth Engine belum terhubung: ' + service.error)
    if not (DATA_DIR / 'k_tanah.csv').exists():
        write_template()
        sys.exit('Isi kolom k di data/k_tanah.csv terlebih dahulu, lalu jalankan ulang.')
    data = json.loads((DATA_DIR / 'tanah.geojson').read_text(encoding='utf-8'))
    # Non-soil units (settlement, water, airport, quarry, bare rock) get no K: EPIC K / masks apply there.
    feats = [f for f in data['features'] if f.get('geometry') and not f['properties'].get('bukan_tanah')]
    table = k_table()
    for f in feats:
        p = f['properties']
        k = table.get(p['jenis'].casefold(), table.get(p['kelompok'].casefold()))
        p['K'], p['k_sumber'] = k, ('tabel k_tanah.csv' if k is not None else None)
    missing = sorted({f['properties']['jenis'] for f in feats if f['properties']['K'] is None})
    if missing:
        print(f'{len(missing)} jenis tanah belum punya nilai K (memakai OpenLandMap): ' + ', '.join(missing[:10]) + ('...' if len(missing) > 10 else ''))
    feats = [f for f in feats if f['properties'].get('K') is not None]
    (DATA_DIR / 'tanah_k.json').write_text(json.dumps(
        [{k: f['properties'][k] for k in ('kelompok', 'jenis', 'K', 'k_sumber')} for f in feats],
        ensure_ascii=False, indent=1), encoding='utf-8')

    # 2) Upload in chunks as table assets.
    folder = f'projects/{service.project}/assets/{service.SOIL_FOLDER}'
    try:
        ee.data.createAsset({'type': 'FOLDER'}, folder)
    except Exception:
        pass  # already exists
    for a in ee.data.listAssets({'parent': folder}).get('assets', []):
        if a['id'].split('/')[-1].startswith('tanah_k'):
            ee.data.deleteAsset(a['id'])
    chunks, cur, size = [], [], 0
    for f in feats:
        slim = {'type': 'Feature', 'geometry': f['geometry'],
                'properties': {k: f['properties'][k] for k in ('kelompok', 'jenis', 'K')}}
        n = len(json.dumps(slim))
        if cur and size + n > CHUNK_BYTES:
            chunks.append(cur); cur, size = [], 0
        cur.append(slim); size += n
    if cur:
        chunks.append(cur)
    tasks = []
    for i, chunk in enumerate(chunks):
        fc = ee.FeatureCollection([ee.Feature(ee.Geometry(c['geometry'], None, False), c['properties']) for c in chunk])
        t = ee.batch.Export.table.toAsset(collection=fc, description=f'envirowatch_tanah_k_{i}',
                                          assetId=f'{folder}/tanah_k_{i}')
        t.start()
        tasks.append(t)
        print(f'Ekspor {i + 1}/{len(chunks)} dimulai ({len(chunk)} jenis tanah)')
    while True:
        states = [t.status()['state'] for t in tasks]
        print('  status:', ', '.join(states), flush=True)
        if all(s in ('COMPLETED', 'FAILED', 'CANCELLED') for s in states):
            break
        time.sleep(20)
    failed = [t.status() for t in tasks if t.status()['state'] != 'COMPLETED']
    if failed:
        sys.exit('Sebagian ekspor gagal: ' + '; '.join(str(f.get('error_message')) for f in failed))
    print('Selesai. Lapisan "Bahaya erosi" kini memakai K dari peta tanah BBSDLP.')


if __name__ == '__main__':
    main()
