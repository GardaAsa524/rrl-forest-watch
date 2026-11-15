"""Monthly refresh – run automatically by APScheduler or manually via CLI."""
from __future__ import annotations
from datetime import datetime
from zoneinfo import ZoneInfo
import json
import sys

from . import biodiversity
from .config import CACHE_DIR
from .gee_service import service, INDICES
from .store import put_stat, stat_key


def refresh_monthly():
    if not service.ready:
        raise RuntimeError(service.error)
    today = datetime.now(ZoneInfo('Asia/Jakarta'))
    year = today.year if today.month > 1 else today.year - 1
    month = today.month - 1 or 12
    done, failed = 0, []
    for y, m in [(year, month), (year, 0)]:
        for index in INDICES:
            for mask in ['trees', 'region']:
                print(f'{index} {y} month={m} mask={mask} ...', flush=True)
                try:
                    put_stat(stat_key('index', index=index, year=y, month=m, mask=mask, area='all'),
                             service.statistics(index, y, m, mask, 'all'))
                    done += 1
                except Exception as exc:
                    failed.append(f'{index}/{y}/{m}/{mask}: {exc}')
    for layer, y in [('erosivity', year), ('degradation', year - 1)]:
        try:
            put_stat(stat_key('env', layer=layer, year=y, mask='region', area='all'),
                     service.env_statistics(layer, y, 'region', 'all'))
            done += 1
        except Exception as exc:
            failed.append(f'{layer}/{y}: {exc}')
    for group in ('animals', 'plants'):
        try:
            biodiversity.get_group(group, 'all', refresh=True)
        except Exception as exc:
            failed.append(f'gbif/{group}: {exc}')
    service._tile_cache.clear()  # expiring tile URLs are rebuilt on request
    (CACHE_DIR / 'last_refresh.json').write_text(json.dumps({
        'last_refresh': today.isoformat(), 'period': f'{year}-{month:02d}',
        'results': done, 'failed': failed}, ensure_ascii=False, indent=2), encoding='utf-8')
    return done, failed


if __name__ == '__main__':
    try:
        done, failed = refresh_monthly()
        print(f'Pembaruan selesai: {done} statistik, {len(failed)} gagal.')
        for f in failed:
            print('  -', f)
    except Exception as exc:
        print(f'Pembaruan gagal: {exc}', file=sys.stderr)
        sys.exit(1)
