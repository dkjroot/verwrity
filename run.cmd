@echo off
setlocal
pushd "%~dp0" || exit /b 1

if not exist "venv\Scripts\python.exe" (
    echo Verwrity's Python environment is missing. Run these commands in this folder:
    echo   py -3 -m venv venv
    echo   .\venv\Scripts\python.exe -m pip install -e .
    popd
    pause
    exit /b 1
)

echo Starting Verwrity. Open http://127.0.0.1:8000 in your browser.
echo Press Ctrl-C to stop the server.
"venv\Scripts\python.exe" -u -m verwrity.web.app
set "verwrity_exit_code=%errorlevel%"
popd
if not "%verwrity_exit_code%"=="0" pause
exit /b %verwrity_exit_code%
