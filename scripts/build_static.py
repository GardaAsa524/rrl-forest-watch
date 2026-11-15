"""Bangun versi statis EnviroWatch untuk GitHub Pages (folder docs/).

GitHub Pages hanya menyajikan file statis, tanpa server Python. Versi ini
membekukan data yang tidak butuh Earth Engine menjadi JSON:
kawasan hutan, DAS, sungai, kabupaten, batas wilayah, dan catatan GBIF.
Fitur Earth Engine (indeks citra, erosivitas, degradasi, kualitas air)
tetap membutuhkan server; isi EW_API_BASE bila server sudah di-deploy.

    .venv\\Scripts\\python.exe scripts\\build_static.py [--api-base https://server-anda]

Lalu di GitHub: Settings → Pages → Branch: main, folder: /docs → Save.
"""
from __future__ import annotations
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app import biodiversity, vectors  # noqa: E402
from app.config import AREAS  # noqa: E402

DOCS = ROOT / 'docs'
FRONTEND = ROOT / 'frontend'


def dump(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


def copy_frontend(api_base: str = ''):
    """Copy the dashboard into docs/ with relative paths and the static-mode flag."""
    if (DOCS / 'static').exists():
        shutil.rmtree(DOCS / 'static')
    shutil.copytree(FRONTEND, DOCS / 'static')
    (DOCS / '.nojekyll').write_text('', encoding='utf-8')  # serve files as-is, no Jekyll
    # Page: relative paths (site lives under /<repo>/) + static-mode flag.
    html = (FRONTEND / 'index.html').read_text(encoding='utf-8').replace('"/static/', '"static/')
    config = (f'<script>window.EW_STATIC=true;window.EW_API_BASE={json.dumps(api_base.rstrip("/"))};</script>\n'
              '  <script defer src="static/app.js')
    html = re.sub(r'<script defer src="static/app\.js', config, html, count=1)
    # The /docs API explorer only exists on the Python server.
    html = re.sub(r'\s*<a class="icon-btn" href="/docs"[^>]*>API</a>', '', html)
    (DOCS / 'index.html').write_text(html, encoding='utf-8')
    (DOCS / 'static' / 'index.html').unlink()
    css = DOCS / 'static' / 'styles.css'
    css.write_text(css.read_text(encoding='utf-8').replace('url("/static/img/', 'url("img/'), encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--api-base', default='', help='URL server EnviroWatch untuk fitur Earth Engine (opsional)')
    ap.add_argument('--with-ee', choices=['no', 'auto', 'yes'], default='auto',
                    help='Sertakan snapshot Earth Engine (peta & statistik). auto = jika Earth Engine terhubung.')
    ap.add_argument('--frontend-only', action='store_true',
                    help='Hanya salin ulang tampilan (HTML/CSS/JS/gambar); data di docs/api tidak diubah.')
    args = ap.parse_args()

    if args.frontend_only:
        copy_frontend(args.api_base)
        print('Tampilan docs/ diperbarui.')
        return
    if DOCS.exists():
        shutil.rmtree(DOCS)
    copy_frontend(args.api_base)


    # API snapshots.
    from app.main import status
    st = status()
    st.update({'ready': False, 'static': True, 'scheduler_enabled': False, 'last_refresh': None, 'snapshot': None,
               'error': 'Versi GitHub Pages (statis): peta kawasan hutan, DAS, sungai, kabupaten, dan '
                        'biodiversitas tersedia. Fitur Earth Engine membutuhkan server EnviroWatch.'})
    from app.gee_service import service
    if args.with_ee == 'yes' or (args.with_ee == 'auto' and service.ready):
        from scripts.ee_snapshot import build as ee_build
        print('Snapshot Earth Engine...')
        st['snapshot'] = ee_build(DOCS)
        st['error'] = ('Versi GitHub Pages: hasil Earth Engine berupa snapshot '
                       f"(diperbarui {st['snapshot']['generated'][:10]}). Profil titik, bulan tertentu, "
                       'dan bercak minyak hanya di versi server.')
    elif args.with_ee == 'auto':
        print(f'  (Earth Engine tidak terhubung, snapshot dilewati: {service.error[:120]})')
    api = DOCS / 'api'
    dump(api / 'status.json', st)
    dump(api / 'layers.json', vectors.catalog())
    for kind in vectors.KINDS:
        dump(api / 'layers' / f'{kind}.json', vectors.load(kind))
    for group in ('animals', 'plants'):
        for area in AREAS:
            try:
                dump(api / 'biodiversity' / f'{group}_{area}.json', biodiversity.get_group(group, area))
            except Exception as exc:  # GBIF offline: page shows a message for that area
                print(f'  ! GBIF {group}/{area}: {exc}')
    size = sum(f.stat().st_size for f in DOCS.rglob('*') if f.is_file()) / 1e6
    print(f'docs/ siap ({size:.1f} MB).')


if __name__ == '__main__':
    main()
