@echo off
setlocal enabledelayedexpansion
title ICAO Runway Tester - Start Server

cd /d "%~dp0"

echo ======================================================
echo    ICAO Runway Tester - Starting Dev Server
echo ======================================================
echo.

set PORT=3500

:: Check if port 3500 is already active
netstat -ano | findstr /R ":%PORT% .*LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [INFO] Server is ALREADY RUNNING on port %PORT%.
    echo Opening browser at http://localhost:%PORT% ...
    start http://localhost:%PORT%
    timeout /t 3 >nul
    exit /b 0
)

echo [STARTING] Launching Node.js server on port %PORT%...
start "ICAO Runway Tester Server" cmd /k "cd /d "%~dp0" && title ICAO Runway Tester Server && node server.js"

:: Wait up to 5 seconds for server to be responsive
echo [WAITING] Waiting for server initialization...
set counter=0
:check_loop
timeout /t 1 /nobreak >nul
netstat -ano | findstr /R ":%PORT% .*LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [SUCCESS] Server is online and listening on http://localhost:%PORT%!
    echo Opening browser...
    start http://localhost:%PORT%
    timeout /t 2 >nul
    exit /b 0
)
set /a counter+=1
if %counter% lss 5 goto check_loop

echo [NOTICE] Server started. Opening browser at http://localhost:%PORT% ...
start http://localhost:%PORT%
timeout /t 2 >nul
exit /b 0
