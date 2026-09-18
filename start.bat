@echo off
rem ============================================================
rem  QuickCopy launcher (Windows)
rem  NOTE: keep this file ASCII-only. cmd.exe mis-parses non-ASCII
rem  bytes in a .bat after "chcp 65001", which breaks the script.
rem  Chinese messages come from server.js (UTF-8) below.
rem ============================================================
setlocal
chcp 65001 >nul
title QuickCopy - local server
cd /d "%~dp0"

rem ---- startup settings (edit these two lines) ----
rem  PORT   : port the local service listens on
rem  CONFIG : default config file. BEWARE: the server listens on all
rem           interfaces now, so anyone on the same LAN can read whatever
rem           this points at. The example file is the safe default.
set "PORT=18437"
set "CONFIG=data\resume.example.json"

echo.
echo   QuickCopy - Resume Copier
echo   ----------------------------------------
echo.

rem ---- 1. is node available? ----
where node >nul 2>nul
if errorlevel 1 (
  echo   [x] Node.js not found.
  echo.
  echo       Please install Node.js 18+ from https://nodejs.org/
  echo       then run this file again.
  echo.
  pause
  exit /b 1
)

rem ---- 2. is it new enough? (read node -v, then cut out the major number) ----
set "NODE_VERSION=unknown"
set "NODE_MAJOR=0"
for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
set "NODE_MAJOR=%NODE_VERSION:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_MAJOR%") do set "NODE_MAJOR=%%a"

if %NODE_MAJOR% LSS 18 (
  echo   [!] Node.js %NODE_VERSION% is too old. Version 18 or newer is required.
  echo.
  pause
  exit /b 1
)

echo   Node.js : %NODE_VERSION%
echo   Port    : %PORT%
echo   Config  : %CONFIG%
echo.
echo   Starting... your browser will open automatically.
echo   Close this window to stop the server.
echo.

rem ---- 3. start (extra args are forwarded and override the defaults above) ----
node server.js --port %PORT% --data "%CONFIG%" %*
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
  echo   Server stopped.
) else (
  echo   [x] Server exited with code %EXITCODE%.
  echo       Common causes: port already in use, or no write permission on the data folder.
)
echo.
pause
exit /b %EXITCODE%
