"""Atomic JSON cache for regional statistics; never stores expiring map tokens."""
from __future__ import annotations
import json
import os
from threading import Lock
from .config import CACHE_DIR

PATH = CACHE_DIR / 'statistics_v2.json'
_LOCK = Lock()


def stat_key(kind: str, **parts) -> str:
    return kind + '/' + '/'.join(f'{k}={parts[k]}' for k in sorted(parts))


def get_stat(key: str):
    with _LOCK:
        try:
            return json.loads(PATH.read_text(encoding='utf-8')).get(key)
        except (OSError, json.JSONDecodeError):
            return None


def put_stat(key: str, result: dict):
    with _LOCK:
        try:
            data = json.loads(PATH.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError):
            data = {}
        data[key] = result
        tmp = PATH.with_suffix('.tmp')
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')
        os.replace(tmp, PATH)
