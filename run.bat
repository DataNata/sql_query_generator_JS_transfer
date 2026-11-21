node dev-server.mjs
@echo off
rem SQL Query Generator (JS) - local launcher. ASCII only: Cyrillic breaks cmd parsing.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js not found. Install Node.js 22+ from https://nodejs.org
    pause
    exit /b 1
)

if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo [i] Created .env - put APP_PASSWORD, SESSION_SECRET and API keys there, save it and run run.bat again.
    echo     Without keys only the demo mode is available.
    start "" notepad ".env"
)

echo [i] SQL Query Generator: http://127.0.0.1:8000  - press Ctrl+C to stop
start "" http://127.0.0.1:8000
node dev-server.mjs
pause
