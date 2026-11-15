# RRL EnviroWatch — Web GIS Pantau Lingkungan Jawa Barat, Banten & DKI Jakarta

Dikembangkan oleh **Ruang Riung Lingkungan**. Mendukung mode terang/gelap (tombol ☾/☀ di kanan atas).

## Modul

| Modul | Isi | Sumber | Realtime? |
|---|---|---|---|
| **Hutan & Biodiversitas** | Fungsi kawasan hutan + luas per kab/kota; catatan jenis pohon; habitat badak jawa, macan tutul, owa jawa, surili, elang jawa | KLHK, BIG, GBIF | GBIF diperbarui bulanan |
| **Daratan** | Indeks citra NDVI/MSARVI/NDWI/NDBI; titik panas kebakaran; **deforestasi 2001–2025** & **alih fungsi lahan 2005→2025**; **bahaya erosi (RUSLE)**, degradasi & erosivitas; tutupan lahan & **jenis tanah**; citra harian | Copernicus Sentinel-2, NASA FIRMS/GIBS, Hansen GFC, MODIS, BBSDLP, Earth Engine | ✅ peta indeks (Copernicus) & titik panas |
| **Perairan** | DAS & sungai; kekeruhan/TSS, klorofil-a, suhu air, bercak minyak | KLHK, BIG, Copernicus, Earth Engine | ✅ peta TSS & klorofil (Copernicus) |
| **Udara** | AQI, PM2.5, PM10, NO₂, SO₂, CO, O₃, aerosol, suhu, kelembapan, angin, hujan per kab/kota; citra atmosfer harian; curah hujan tahunan | Open-Meteo (CAMS), NASA GIBS (TROPOMI, MODIS, IMERG), CHIRPS | ✅ |

Statistik dan grafik tren dihitung Google Earth Engine (langsung di versi server, snapshot bulanan di GitHub Pages).

## Sumber realtime & keamanannya

| Sumber | Butuh kunci? | Yang terlihat publik | Risiko |
|---|---|---|---|
| NASA GIBS / FIRMS | Tidak | — | Aman |
| Open-Meteo | Tidak | — | Aman. Gratis untuk nonkomersial (< 10.000 permintaan/hari) |
| Copernicus Data Space (Sentinel Hub WMS) | Instance ID | Instance ID di kode halaman | Bukan password; orang lain hanya bisa memakai **kuota** Anda. Batasi domain di dashboard |
| Google Earth Engine (GitHub Actions) | Kunci service account | Tidak ada (tersimpan di GitHub Secrets) | Aman selama file JSON tidak dibagikan |

Jangan pernah menaruh *client secret* OAuth Copernicus atau kunci JSON Earth Engine di frontend atau di repo.

### Mengaktifkan peta realtime Copernicus (opsional)

1. Daftar gratis di https://dataspace.copernicus.eu.
2. Buka *Sentinel Hub Dashboard* (https://shapps.dataspace.copernicus.eu/dashboard/) → **Configuration Utility → New configuration** (template *Simple WMS*).
3. Pastikan ada layer dengan ID **`S2L2A`** dan sumber data **Sentinel-2 L2A** (evalscript bebas; website mengirim evalscript sendiri).
4. Salin **Instance ID** konfigurasi tersebut. Bila tersedia, batasi *allowed referrers* ke `gardaasa524.github.io` dan `127.0.0.1`.
5. GitHub: *Settings → Secrets and variables → Actions → tab **Variables** → New repository variable* `CDSE_INSTANCE_ID` = instance ID.
   Untuk versi server: isi `CDSE_INSTANCE_ID=` di `.env`.
6. Jalankan ulang workflow Pages.

## Dua cara membuka

| | Versi server (lengkap, live) | Versi GitHub Pages |
|---|---|---|
| Cara buka | `JALANKAN_WEBGIS.bat` → http://127.0.0.1:8000 | https://gardaasa524.github.io/rrl-forest-watch/ |
| Kawasan hutan, kabupaten, DAS, sungai, satwa (GBIF) | ✅ | ✅ |
| Indeks citra, erosivitas, degradasi, kualitas air | ✅ semua tahun/bulan, resolusi penuh | ✅ **snapshot** Earth Engine: tahun 2020 & tahun lengkap terakhir, tahunan, ±200 m, statistik seluruh wilayah |
| Profil titik (klik peta), bulan tertentu, bercak minyak | ✅ | ❌ |
| Pembaruan | saat diminta | otomatis tiap tanggal 10 (GitHub Actions) + setiap push |

## Deploy ke GitHub Pages (GitHub Actions + Earth Engine)

Workflow `.github/workflows/pages.yml` menjalankan `scripts/build_static.py --with-ee auto` di server GitHub, lalu menerbitkan hasilnya ke Pages. Earth Engine login memakai **service account** (bukan akun pribadi). Persiapan satu kali:

1. **Buat service account** di Google Cloud Console project `gardaasa524`:
   *IAM & Admin → Service Accounts → Create service account* (mis. `envirowatch-ci`).
   Beri peran **Earth Engine Resource Viewer** dan **Service Usage Consumer**.
2. **Buat kunci JSON**: buka service account tersebut → *Keys → Add key → Create new key → JSON*. File `.json` terunduh. **Jangan commit file ini.**
3. **Simpan di GitHub**: repo → *Settings → Secrets and variables → Actions → New repository secret*.
   Name: `EE_SERVICE_ACCOUNT_KEY`, Secret: tempel **seluruh isi** file JSON.
4. **Aktifkan Pages dari Actions**: *Settings → Pages → Build and deployment → Source: GitHub Actions*.
5. Jalankan: tab *Actions → Deploy EnviroWatch ke GitHub Pages → Run workflow* (atau push ke `main`). ±15–30 menit.

Tanpa secret, workflow tetap menerbitkan situs (tanpa lapisan Earth Engine). Untuk mencoba di komputer sendiri: `.venv\Scripts\python.exe scripts\build_static.py --with-ee yes` (memakai login Earth Engine lokal), hasil di `docs/`.

## Versi 0.2: modul baru

| Modul | Isi | Sumber data |
|---|---|---|
| **Jenis Hutan** | Luas kawasan hutan per kabupaten/kota (41 kab/kota). Fungsi kawasan: Hutan Produksi (tetap/terbatas/konversi), Hutan Lindung, Hutan Konservasi; luas per kelas. Tutupan lahan aktual WorldCover 2021 | KLHK Kawasan Hutan 2023, BIG batas kab/kota + Earth Engine |
| **Biodiversitas A: Jenis tanaman** | Peta tegakan (pinus, jati, mahoni, damar, rasamala, sengon, mangrove, dll.) + catatan sebaran jenis pohon | GBIF (peta tegakan Perhutani belum tersedia) |
| **Biodiversitas B: Habitat satwa** | Badak Jawa (+ batas TN Ujung Kulon), Macan Tutul Jawa, Owa Jawa, Surili, Elang Jawa: sebaran catatan per sel ±11 km, status IUCN, konteks habitat hutan | GBIF (iNaturalist, museum, survei) |
| **Indeks Citra** | NDVI, MSARVI, NDWI, NDBI 10 m, tahunan/bulanan, perbandingan dua tahun (geser), tren tahunan | Sentinel-2 SR via Google Earth Engine |
| **Kualitas Air** | Kekeruhan/TSS (Nechad), klorofil-a (NDCI), suhu permukaan air (Landsat), bercak gelap radar (indikasi minyak) + 8 area fokus (Teluk Jakarta, Muara Citarum, waduk, dll.) | Sentinel-2, Landsat 8/9, Sentinel-1 via Earth Engine |
| **Lingkungan** | Erosivitas hujan (faktor R, Lenvain), curah hujan, indikasi degradasi lahan (tren NDVI 2001–sekarang) dengan sebaran kelas & luas | CHIRPS, MODIS MOD13Q1 via Earth Engine |

Klik di mana saja pada peta untuk melihat **profil lokasi** (keempat indeks, R, curah hujan, tren NDVI, ketinggian, kemiringan, tutupan lahan).

### Data vektor bawaan (Jabar, Banten, DKI Jakarta)

| File | Isi | Sumber |
|---|---|---|
| `data/kawasan_hutan.geojson` | Fungsi kawasan (konservasi, lindung, produksi tetap/terbatas); APL tidak disertakan | KLHK, Kawasan Hutan 2023 |
| `data/das.geojson` | Batas DAS + status DAS prioritas, dipotong ke wilayah | KLHK, Batas DAS se-Indonesia |
| `data/sungai.geojson` | Garis tengah sungai skala 1:250.000 | BIG, Sungai Line 250K |
| `data/kabupaten.geojson` | Batas 41 kabupaten/kota + luas tiap fungsi kawasan hutan | BIG, Batas Kabupaten PPBW v1 |
| `data/batas_wilayah.geojson` | Batas 3 provinsi | FAO GAUL 2025 (via Earth Engine) |

Website **tidak menerima unggahan file**; data hanya diperbarui oleh admin. Untuk membangun ulang dari data nasional:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-data.txt
.\.venv\Scripts\python.exe scripts\build_data.py --source "J:\kuliah\DATA DASAR\Vector"
```

Peta jenis tegakan (pinus, jati, dll.) belum tersedia. Bila ada data Perhutani, simpan sebagai `data/jenis_tegakan.geojson` (EPSG:4326, atribut `JENIS`/`TEGAKAN`) lalu restart server.

Logo: `scripts/make_logo.py` menghapus latar putih logo dan menyimpan PNG transparan ke `frontend/img/`.

### Erosi (RUSLE) & peta jenis tanah

- `A = R × K × LS × C × P` (ton/ha/tahun). R: Lenvain dari CHIRPS. K: erodibilitas tanah. LS: MERIT Hydro (Moore & Burch). C: NDVI MODIS (van der Knijff). P = 1. Kelas bahaya erosi: < 15, 15–60, 60–180, 180–480, > 480 ton/ha/tahun.
- Peta tanah semi detail BBSDLP (1:50.000) dipotong ke wilayah: `scripts\build_data.py --only tanah` → `data/tanah.geojson` (detail) & `data/tanah_web.geojson` (website).
- **Nilai K per jenis tanah**: peta BBSDLP hanya berisi nama jenis tanah. Isi kolom `k` & `sumber` di `data/k_tanah.csv` (68 jenis, dibuat dengan `scripts\upload_soil_k.py --template`) dari referensi/lab, lalu jalankan `scripts\upload_soil_k.py` untuk mengunggahnya ke Earth Engine. Selama belum diisi, K memakai tekstur OpenLandMap (perbedaan antarjenis tanah kecil).

### Deforestasi & alih fungsi lahan

- Kehilangan tutupan pohon 2001–2025: Hansen/UMD GFC v1.13 (30 m, tutupan pohon 2000 ≥ 30%). Termasuk tebang panen hutan tanaman, bukan hanya deforestasi permanen.
- Alih fungsi lahan 2005→2025: MODIS MCD12Q1 (500 m), indikatif untuk tren regional.

### Catatan metode singkat

- **MSARVI** = (2N+1 − √((2N+1)² − 8(N − RB)))/2, RB = R − γ(B − R), γ = 1. **NDWI** versi McFeeters (B3, B8). **NDBI** = (B11 − B8)/(B11 + B8).
- **Erosivitas**: R bulanan = 2,21 × P^1,36 (P cm/bulan, CHIRPS); R tahunan = jumlahnya. Kelas bersifat relatif.
- **Degradasi**: kemiringan regresi linier rerata NDVI tahunan MODIS; < −0,003/tahun = indikasi degradasi. Ini indikasi, bukan peta degradasi resmi.
- Lokasi satwa terancam sengaja diagregasi ke sel ±11 km agar tidak membantu perburuan.

---

## Dokumentasi versi 0.1 (masih berlaku untuk instalasi & koneksi Earth Engine)

**Proyek Web GIS siap dibuka di Visual Studio Code (VS Code).**

Versi: MVP 0.1 — aplikasi berjalan secara lokal di `http://127.0.0.1:8000`.

> Penting: **data NDVI bukan data dummy**. Peta dasar OpenStreetMap bisa langsung dilihat. Lapisan NDVI, nilai piksel, grafik, dan statistik **baru muncul setelah Google Earth Engine (GEE) berhasil dihubungkan**. Jika belum terhubung, aplikasi menampilkan status jujur, bukan nilai NDVI palsu. Pengujian koneksi Earth Engine membutuhkan kredensial pengguna.

## Yang sudah dibuat

- Desain dashboard RRL EnviroWatch yang responsif.
- Dua peta Leaflet yang sinkron untuk membandingkan tahun **2020 sampai tahun berjalan**.
- Pilihan periode **tahunan** atau **bulanan** (bulan yang telah selesai).
- Layer NDVI Sentinel-2 Surface Reflectance Harmonized **10 m**.
- Filter **tutupan pohon dan mangrove ESA WorldCover 2021** atau seluruh wilayah Jawa Barat.
- Legenda indeks, kontrol transparansi, klik lokasi untuk membaca nilai NDVI.
- Grafik rerata NDVI antartahun (diolah saat diminta; hasil kemudian di-cache).
- Backend FastAPI dan API Earth Engine.
- **Penjadwal otomatis tanggal 10 setiap bulan pukul 04.00 WIB** (saat aplikasi/server berjalan) untuk memperbarui ringkasan NDVI bulan lalu serta tahun berjalan.
- Arsip statistik lokal di `cache/statistics.json`; peta dihitung on-demand sehingga tidak bergantung pada URL tile yang kedaluwarsa.
- Pengaturan VS Code (`.vscode/launch.json`) untuk menjalankan aplikasi via F5.

## A. Cara termudah di Windows (pemula)

### A1. Jalankan dulu peta dasar (tanpa Earth Engine)

1. Instal **Python 3.11 atau lebih baru** dan **Visual Studio Code**. Saat memasang Python, centang `Add Python to PATH`.
2. Ekstrak ZIP ini, lalu buka folder `RRL-EnviroWatch-VSCode`.
3. **Klik dua kali `JALANKAN_WEBGIS.bat`**.
4. File `.env` akan dibuat dari `.env.example`, virtual environment dibuat, dan paket dipasang (butuh internet saat instalasi pertama).
5. Buka `http://127.0.0.1:8000`. Anda akan melihat dashboard dengan **peta dasar**, namun NDVI masih perlu langkah A2.

> Untuk menghentikan server, tekan `Ctrl+C` pada jendela terminal yang berjalan.

### A2. Hubungkan NDVI Sentinel-2 asli

1. Siapkan akun yang sudah mendapatkan **akses Google Earth Engine**: <https://earthengine.google.com/>.
2. Buat atau pilih **Google Cloud Project** dan pastikan Earth Engine API terdaftar/diaktifkan pada project tersebut. Panduan resmi: <https://developers.google.com/earth-engine/guides/access>.
3. Buka folder proyek di VS Code melalui **File → Open Folder**, pilih `RRL-EnviroWatch-VSCode`.
4. Buka file `.env`. Ubah `GOOGLE_CLOUD_PROJECT=` menjadi **ID project Anda**, bukan nama tampilan project, contoh `GOOGLE_CLOUD_PROJECT=rrl-forestwatch-123456` (contoh bukan project nyata).
5. Simpan file `.env`.
6. Klik dua kali `HUBUNGKAN_EARTH_ENGINE.bat` dan lakukan login pada browser saat diminta. Anda juga bisa mengetik `earthengine authenticate` di terminal virtual environment.
7. Tutup server lama dengan `Ctrl+C`, kemudian jalankan ulang `JALANKAN_WEBGIS.bat`.
8. Jika status atas menunjukkan **EARTH ENGINE TERHUBUNG**, klik **Tampilkan peta NDVI** atau **Hitung statistik & grafik**.

**Jangan kirim `.env`, token akun Google, atau kredensial servis akun ke publik.** File `.env` dikecualikan dari Git melalui `.gitignore`.

## B. Cara buka dan menjalankan melalui VS Code

1. VS Code → **File → Open Folder** → pilih folder ekstraksi.
2. Buka **Terminal → New Terminal**.
3. Jalankan (PowerShell):

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

4. Isi `GOOGLE_CLOUD_PROJECT` di `.env` (setelah memperoleh akses Earth Engine).
5. Autentikasi satu kali:

```powershell
.\.venv\Scripts\earthengine.exe authenticate
```

6. Jalankan (PowerShell):

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

7. Buka `http://127.0.0.1:8000`.

Atau pilih interpreter `.venv`, buka **Run and Debug**, pilih **Jalankan RRL EnviroWatch (FastAPI)**, lalu **F5**.

Catatan: Jangan menjalankan HTML dengan ekstensi **Live Server** secara terpisah, karena aplikasi memakai API backend Python (`/api/...`). Jalankan melalui FastAPI sesuai langkah di atas.

## C. Cara kerja NDVI & interpretasi data

### Dataset

- Sentinel-2 Surface Reflectance Harmonized: `COPERNICUS/S2_SR_HARMONIZED`.
- Band NIR = **B8 (10 m)**, band merah = **B4 (10 m)**.
- Rumus: **NDVI = (B8 - B4) / (B8 + B4)**.
- Mask awan per-piksel menggunakan SCL: hanya kelas 4 (vegetasi), 5 (bare soil), dan 6 (water) yang dipertahankan. Sebagian data valid dapat terbuang, terutama karena kelas tidak pasti.
- Komposit **median NDVI** dihitung dari pengamatan valid sepanjang periode terpilih.
- Footprint untuk mode hutan menggunakan **ESA WorldCover v200 tahun 2021**, kelas **10 (tree cover)** dan **95 (mangroves)**, sama untuk semua tahun agar area perbandingannya tetap.
- Batas Provinsi Jawa Barat dari **FAO GAUL 2025** di GEE, dengan fallback GAUL 2015 bila perlu. Untuk hasil penelitian/kebijakan, verifikasi dengan batas resmi BIG/Kementerian Kehutanan.
- Grafik statistik regional menghitung rerata dengan skala **250 m** (performa), bukan sensus seluruh piksel NDVI 10 m. Catat pendekatan ini dalam laporan.

### Hal yang tidak boleh disimpulkan langsung

- **Tutupan pohon WorldCover 2021 bukan batas kawasan hutan resmi**, dan bukan pengganti peta tutupan hutan tahunan.
- **Perubahan NDVI tidak otomatis sama dengan deforestasi**, degradasi permanen, atau keberhasilan rehabilitasi. Butuh pembanding, musim, data tutupan lahan, serta survei.
- **Tahun berjalan tidak sama dengan tahun penuh**. Untuk tahun berjalan aplikasi hanya mengolah bulan yang sudah selesai. Sebaiknya gunakan periode kalender sama saat membandingkan tahun berbeda.
- **NDVI bukan ukuran langsung kesehatan hutan** dan bisa mengalami saturasi pada hutan lebat.
- Data tanpa piksel valid (misalnya tertutup awan) ditampilkan sebagai **tidak tersedia**, bukan NDVI nol.
- Data NDVI, nilai rerata, dan statistik di dashboard hanya tampil setelah Earth Engine memberi hasil perhitungan sungguhan.

## D. Pembaruan otomatis bulanan

Jika `ENABLE_SCHEDULER=true` (nilai bawaan), aplikasi membuat job pada **tanggal 10 setiap bulan pukul 04.00 WIB**. Job akan:

1. Mengambil data NDVI untuk **bulan kalender sebelumnya**.
2. Menghitung statistik bulan tersebut dan komposit **tahun berjalan**.
3. Memproses dua mode area (tutupan pohon/mangrove dan seluruh Jawa Barat).
4. Menulis hasil ke `cache/statistics.json` dan `cache/last_refresh.json`.
5. Menghapus cache URL tile sementara agar peta berikutnya meminta citra terbaru dari GEE.

**Penting:** job hanya berjalan jika server tetap hidup saat jadwal. Untuk operasional **24/7**, host di server yang aktif terus atau gunakan penjadwalan cloud. Komposit NDVI ditampilkan dari GEE *on-demand*, bukan GeoTIFF yang diekspor otomatis ke server. Proses perhitungan dapat gagal jika akses GEE atau data satelit terganggu; tidak ada jaminan data bebas awan untuk setiap bulan.

Menjalankan pembaruan secara manual:

```powershell
.\.venv\Scripts\python.exe -m app.refresh
```

Jika memilih mode tahunan 2026 pada November 2026, aplikasi menggunakan periode **Januari sampai Oktober 2026**, bukan bulan November yang belum selesai. **Jangan langsung membandingkan dengan seluruh Januari–Desember 2020/2025 sebagai perubahan setahun** tanpa periode setara.

## E. Struktur folder

```text
RRL-EnviroWatch-VSCode/
├─ app/
│  ├─ __init__.py
│  ├─ main.py                 # API FastAPI dan scheduler
│  ├─ gee_service.py          # NDVI Sentinel-2, batas, peta, statistik
│  ├─ config.py               # .env dan konfigurasi
│  ├─ store.py                # cache statistik JSON
│  └─ refresh.py              # proses pembaruan bulanan
├─ frontend/
│  ├─ index.html              # dashboard
│  ├─ styles.css              # tampilan responsif
│  └─ app.js                  # peta Leaflet, perbandingan, grafik
├─ tests/
│  └─ test_app.py
├─ cache/
├─ .vscode/launch.json
├─ .env.example
├─ requirements.txt
├─ JALANKAN_WEBGIS.bat
├─ HUBUNGKAN_EARTH_ENGINE.bat
└─ README.md
```

## F. API endpoint

- `GET /api/status` — informasi koneksi dan penjadwalan.
- `GET /api/boundary` — GeoJSON batas Jawa Barat jika GEE aktif.
- `GET /api/map?year=2020&month=0&mask=trees` — tile URL dari NDVI asli.
- `GET /api/statistics?year=2025&month=0&mask=trees` — statistik rerata, p10, p90, jumlah sampel valid.
- `GET /api/pixel?lat=-6.8&lon=107.5&year=2025&month=0&mask=trees` — nilai NDVI pada titik yang diklik.
- Dokumentasi interaktif: `http://127.0.0.1:8000/docs`.

## G. Hal yang masih perlu untuk versi produksi

Ini adalah **MVP lokal**, belum platform produksi publik. Untuk deployment serius tambahkan:

- Akun service account yang aman untuk proses GEE otomatis 24/7.
- Cloud Scheduler / cron eksternal, sistem monitoring job dan notifikasi kegagalan.
- Database PostGIS dan penyimpanan raster GeoTIFF/COG untuk arsip terverifikasi.
- Peta **tutupan hutan tahunan yang tervalidasi**, dan layer **kawasan hutan legal resmi** terpisah.
- Statistik per kabupaten/kota, analisis kelas NDVI dan identifikasi lokasi prioritas dengan validasi lapangan.
- Autentikasi admin, rate limiting, pembatasan biaya/kuota GEE dan pengamanan API apabila dipublikasikan.
- Pengujian akurasi, kualitas citra, konsistensi musiman, dan uji pengguna RRL.

## H. Rujukan & lisensi data

- [Earth Engine Authentication](https://developers.google.com/earth-engine/guides/auth)
- [Sentinel-2 SR Harmonized](https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED)
- [ESA WorldCover v200](https://developers.google.com/earth-engine/datasets/catalog/ESA_WorldCover_v200) (CC BY 4.0)
- [FAO GAUL 2025](https://developers.google.com/earth-engine/datasets/catalog/FAO_GAUL_SIMPLIFIED_500m_2025_level1) (CC BY 4.0)
- [OpenStreetMap](https://www.openstreetmap.org/copyright)
- [Leaflet](https://leafletjs.com/)

Penggunaan akun GEE gratis bergantung pada status dan kelayakan proyek nonkomersial. Periksa kebijakan Earth Engine sebelum mengembangkan layanan komersial, CSR atau berbayar.
