@echo off
setlocal enabledelayedexpansion
title ICAO Runway Tester - Stop Server

cd /d "%~dp0"

echo ======================================================
echo    ICAO Runway Tester - Stopping Dev Server
echo ======================================================
echo.

set PORT=3500
set KILLED=0

:: Method 1: Find PID by listening port 3500 and kill it
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R ":%PORT% .*LISTENING"') do (
    set PID=%%a
    if defined PID (
        if not "!PID!"=="0" (
            echo [STOPPING] Found server running on PID !PID!. Terminating process...
            taskkill /F /PID !PID! >nul 2>&1
            set KILLED=1
        )
    )
)

:: Method 2: Close any cmd window with title "ICAO Runway Tester Server"
taskkill /F /FI "WINDOWTITLE eq ICAO Runway Tester Server*" >nul 2>&1

:: Verify if stopped
timeout /t 1 /nobreak >nul
netstat -ano | findstr /R ":%PORT% .*LISTENING" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    if "!KILLED!"=="1" (
        echo [SUCCESS] ICAO Runway Tester server on port %PORT% has been stopped.
    ) else (
        echo [INFO] Server was not running (Port %PORT% is clear).
    )
) else (
    echo [WARNING] Server might still be active. Attempting fallback termination...
    powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3500 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
    echo [DONE] Cleanup executed.
)

echo.
timeout /t 2 >nul
exit /b 0
