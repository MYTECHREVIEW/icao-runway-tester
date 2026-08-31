@echo off
setlocal enabledelayedexpansion
title ICAO Runway Tester - Control Center
cd /d "%~dp0"
set PORT=3500

:MENU
cls
echo ================================================================
echo        ICAO RUNWAY TESTER - LOCAL DEV LAUNCHER
echo ================================================================
echo.
:: Check Port Status
netstat -ano | findstr /R ":%PORT% .*LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo   Server Status: [ONLINE]  --  http://localhost:%PORT%
) else (
    echo   Server Status: [OFFLINE]
)
echo.
echo ----------------------------------------------------------------
echo   [1] Start Server
echo   [2] Stop Server
echo   [3] Restart Server
echo   [4] Open in Browser (http://localhost:%PORT%)
echo   [5] Launch Visual GUI Controller
echo   [6] Refresh Status
echo   [0] Exit
echo ----------------------------------------------------------------
echo.
set /p CHOICE="Enter choice [0-6]: "

if "%CHOICE%"=="1" goto START_SERVER
if "%CHOICE%"=="2" goto STOP_SERVER
if "%CHOICE%"=="3" goto RESTART_SERVER
if "%CHOICE%"=="4" goto OPEN_BROWSER
if "%CHOICE%"=="5" goto LAUNCH_GUI
if "%CHOICE%"=="6" goto MENU
if "%CHOICE%"=="0" exit /b 0

echo Invalid selection.
timeout /t 1 >nul
goto MENU

:START_SERVER
echo.
netstat -ano | findstr /R ":%PORT% .*LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [INFO] Server is already running.
) else (
    echo [STARTING] Launching Node server...
    start "ICAO Runway Tester Server" cmd /k "cd /d "%~dp0" && title ICAO Runway Tester Server && node server.js"
    timeout /t 2 >nul
)
goto MENU

:STOP_SERVER
echo.
echo [STOPPING] Terminating server on port %PORT%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R ":%PORT% .*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
taskkill /F /FI "WINDOWTITLE eq ICAO Runway Tester Server*" >nul 2>&1
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3500 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
timeout /t 1 >nul
goto MENU

:RESTART_SERVER
echo.
echo [RESTARTING] Stopping active server...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R ":%PORT% .*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
taskkill /F /FI "WINDOWTITLE eq ICAO Runway Tester Server*" >nul 2>&1
timeout /t 1 >nul
echo [STARTING] Launching Node server...
start "ICAO Runway Tester Server" cmd /k "cd /d "%~dp0" && title ICAO Runway Tester Server && node server.js"
timeout /t 2 >nul
goto MENU

:OPEN_BROWSER
start http://localhost:%PORT%
goto MENU

:LAUNCH_GUI
start wscript.exe "%~dp0Launch-GUI.vbs"
goto MENU
