@echo off
cd /d "%~dp0"
if not exist ".env" copy /Y ".env.example" ".env" >nul
if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv
  if errorlevel 1 (echo Python 3 belum terpasang. Install Python 3.11+ dan ulangi.&pause&exit /b 1)
)
call ".venv\Scripts\activate.bat"
python -m pip install -r requirements.txt
if errorlevel 1 (echo Instalasi gagal. Periksa koneksi internet.&pause&exit /b 1)
echo.
echo RRL EnviroWatch: buka http://127.0.0.1:8000
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
pause
