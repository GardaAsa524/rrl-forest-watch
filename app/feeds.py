"""Environmental news aggregator (RSS), cached locally.

Sources that do not allow browser (CORS) access are fetched here, on the
server or during the GitHub Pages build; the browser geocodes each item to a
kabupaten/kota or landmark mentioned in it.
"""
from __future__ import annotations
import html
import json
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from email.utils import parsedate_to_datetime
from threading import Lock

from .config import CACHE_DIR

USER_AGENT = 'Mozilla/5.0 (compatible; EnviroWatch/0.3; +https://gardaasa524.github.io/rrl-forest-watch/)'
CACHE = CACHE_DIR / 'news.json'
CACHE_SECONDS = 30 * 60
MAX_AGE_DAYS = 30

FEEDS = [
    ('Mongabay Indonesia', 'https://www.mongabay.co.id/feed/'),
    ('Ekuatorial', 'https://www.ekuatorial.com/feed/'),
    ('Greenpeace Indonesia', 'https://www.greenpeace.org/indonesia/feed/'),
]
# Google News searches gather many local outlets (Pikiran Rakyat, Detik Jabar, Kompas, Antara, ...).
GOOGLE_QUERIES = [
    'lingkungan Jawa Barat', 'lingkungan Banten', 'lingkungan hidup Jakarta',
    'banjir Jawa Barat', 'longsor Jawa Barat', 'banjir Banten', 'banjir Jakarta',
    'pencemaran sungai Citarum', 'kualitas udara Jakarta', 'kebakaran hutan Jawa Barat',
    'deforestasi Jawa Barat', 'sampah Bandung', 'satwa liar Jawa Barat', 'kekeringan Jawa Barat',
]
_LOCK = Lock()
# Google News results are broad; keep only items whose title is about the environment or disasters.
ENV_WORDS = re.compile(r'lingkungan|hutan|banjir|longsor|sampah|sungai|satwa|polusi|udara|pencemar|limbah|iklim|emisi|'
                       r'kebakaran|karhutla|kekeringan|kemarau|air|laut|pesisir|mangrove|tambang|deforestasi|konservasi|'
                       r'owa|macan|elang|badak|surili|gempa|cuaca|angin|puting beliung|erosi|abrasi|energi|karbon|pltu|'
                       r'tanah|lahan|das|citarum|ciliwung|cisadane|bencana|bpbd|bmkg|tpa|reboisasi|penghijauan|'
                       r'banjir rob|rob|krisis iklim|ekosistem|taman nasional|cagar alam|kualitas air|ispu|pm2', re.I)
_TAG = re.compile(r'<[^>]+>')


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/rss+xml, application/xml'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def _text(s: str | None, limit: int = 320) -> str:
    s = html.unescape(_TAG.sub(' ', s or ''))
    s = re.sub(r'\s+', ' ', s).strip()
    return s[:limit].rsplit(' ', 1)[0] + '…' if len(s) > limit else s


def _date(s: str | None):
    try:
        return parsedate_to_datetime(s).isoformat()
    except Exception:
        return None


def _parse(xml: bytes, source: str, google: bool = False):
    root = ET.fromstring(xml)
    out = []
    for it in root.iter('item'):
        fields = {c.tag.split('}')[-1]: (c.text or '') for c in it}
        title = _text(fields.get('title'), 300)
        src = source
        if google:  # "Judul berita - Nama Media"
            src = fields.get('source') or src
            if ' - ' in title:
                title = title.rsplit(' - ', 1)[0]
        out.append({
            'title': title, 'link': fields.get('link', '').strip(), 'source': src.strip(),
            'published': _date(fields.get('pubDate')),
            'summary': '' if google else _text(fields.get('description') or fields.get('encoded')),
            'locations': _text(fields.get('locations'), 120),
            'tags': _text(fields.get('topic-tags') or fields.get('category'), 160),
            'via': 'Google News' if google else source,
        })
    return out


def _fetch_one(job):
    name, url, google = job
    try:
        return _parse(_get(url), name, google)
    except Exception as exc:  # one broken feed must not hide the others
        return [{'error': f'{name}: {exc}'}]


def fetch_news():
    jobs = [(n, u, False) for n, u in FEEDS]
    jobs += [(f'Google News · {q}',
              'https://news.google.com/rss/search?' + urllib.parse.urlencode(
                  {'q': f'{q} when:14d', 'hl': 'id', 'gl': 'ID', 'ceid': 'ID:id'}), True) for q in GOOGLE_QUERIES]
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(_fetch_one, jobs))
    items, errors, seen = [], [], set()
    cutoff = time.time() - MAX_AGE_DAYS * 86400
    for batch in results:
        for it in batch:
            if 'error' in it:
                errors.append(it['error'])
                continue
            key = re.sub(r'\W+', '', it['title'].casefold())[:80]
            if not it['title'] or key in seen:
                continue
            if it['via'] == 'Google News' and not ENV_WORDS.search(it['title']):
                continue
            seen.add(key)
            try:
                from datetime import datetime
                if it['published'] and datetime.fromisoformat(it['published']).timestamp() < cutoff:
                    continue
            except ValueError:
                pass
            items.append(it)
    items.sort(key=lambda i: i['published'] or '', reverse=True)
    return {'fetched': time.time(), 'items': items[:200], 'errors': errors,
            'sources': [n for n, _ in FEEDS] + ['Google News (berbagai media)']}


def get_news(refresh: bool = False):
    with _LOCK:
        if not refresh:
            try:
                cached = json.loads(CACHE.read_text(encoding='utf-8'))
                if time.time() - cached['fetched'] < CACHE_SECONDS:
                    return cached
            except (OSError, ValueError, KeyError):
                pass
        data = fetch_news()
        if data['items']:
            tmp = CACHE.with_suffix('.tmp')
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
            tmp.replace(CACHE)
        return data


# ----------------------------------------------------------- BNPB disasters
BNPB_EVENTS = 'https://gis.bnpb.go.id/server/rest/services/Kejadian_Bencana_Mingguan/MapServer/25/query'
BNPB_FIELDS = ('dt,kabupaten,kategori_bencana,jumlah_kejadian,meninggal,hilang,luka_sakit,mengungsi,rumah_rusak,'
               'rumah_terendam,lahan_hektar,kronologis,kondisi_mutakhir,id_kab_sdi')
_BNPB_CACHE: dict = {}


def bnpb_events(codes: list[str], count_only: bool = False):
    """Weekly BNPB disaster reports (proxy for the server version), cached 10 min.

    BNPB's server fails on OR-combined LIKE filters, so all weekly reports are fetched
    (a few dozen) and filtered here by province code prefix.
    """
    hit = _BNPB_CACHE.get('all')
    if not hit or time.time() - hit[0] > 600:
        params = {'where': '1=1', 'outFields': BNPB_FIELDS, 'returnGeometry': 'false', 'f': 'json'}
        hit = (time.time(), json.loads(_get(BNPB_EVENTS + '?' + urllib.parse.urlencode(params))))
        _BNPB_CACHE['all'] = hit
    data = hit[1]
    feats = data.get('features', [])
    if count_only:
        return {'count': len(feats)}
    codes = tuple(c for c in codes if c.isdigit() and len(c) == 2)
    sel = [f for f in feats if str(f['attributes'].get('id_kab_sdi') or '').startswith(codes)]
    sel.sort(key=lambda f: f['attributes'].get('dt') or 0, reverse=True)
    return {'features': sel, 'total': len(feats)}
