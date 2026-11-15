"""Settings are read from .env in the project root, not from source code."""
from __future__ import annotations
import os
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env')
PROJECT = os.getenv('GOOGLE_CLOUD_PROJECT', '').strip()
SCHEDULER_ENABLED = os.getenv('ENABLE_SCHEDULER', 'true').lower() in ('1', 'true', 'yes', 'on')
# Copernicus Data Space (Sentinel Hub OGC). Instance ID is public by design (used in the browser);
# restrict it to your domain in the CDSE dashboard. Never put OAuth client secrets here.
CDSE_INSTANCE_ID = os.getenv('CDSE_INSTANCE_ID', '').strip()
CDSE_LAYER = os.getenv('CDSE_LAYER', 'S2L2A').strip() or 'S2L2A'
CACHE_DIR = ROOT / 'cache'
CACHE_DIR.mkdir(exist_ok=True)
# User-supplied vector layers (kawasan hutan, jenis tegakan) live here.
DATA_DIR = ROOT / 'data'
DATA_DIR.mkdir(exist_ok=True)

# Wilayah pantauan. Kunci dipakai di API (?area=...).
AREAS = {
    'all': {'label': 'Jabar · Banten · Jakarta', 'provinces': ['Jawa Barat', 'Banten', 'DKI Jakarta']},
    'jabar': {'label': 'Jawa Barat', 'provinces': ['Jawa Barat']},
    'banten': {'label': 'Banten', 'provinces': ['Banten']},
    'jakarta': {'label': 'DKI Jakarta', 'provinces': ['DKI Jakarta']},
}
# Kode provinsi BPS/Kemendagri, dipakai untuk memotong data vektor nasional.
PROVINCE_CODES = {'DKI Jakarta': 31, 'Jawa Barat': 32, 'Banten': 36}
