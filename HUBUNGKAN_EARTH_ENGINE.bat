@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Jalankan JALANKAN_WEBGIS.bat terlebih dahulu agar dependensi terinstal.
  pause
  exit /b 1
)
echo.
echo 1. Pastikan akun Earth Engine Anda sudah aktif dan punya Google Cloud project.
echo 2. Isi GOOGLE_CLOUD_PROJECT di file .env, lalu simpan.
echo 3. Lanjutkan login browser saat diminta.
echo.
".venv\Scripts\earthengine.exe" authenticate
if errorlevel 1 (echo Login gagal.&pause&exit /b 1)
echo Selesai. Tutup dan jalankan ulang JALANKAN_WEBGIS.bat.
pause
