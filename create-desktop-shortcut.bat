@echo off
setlocal
cd /d "%~dp0"

echo Creating Desktop Shortcuts for ICAO Runway Tester...

powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; " ^
  "$desktop = [Environment]::GetFolderPath('Desktop'); " ^
  "$s1 = $ws.CreateShortcut(\"$desktop\ICAO Runway Tester (GUI).lnk\"); " ^
  "$s1.TargetPath = 'wscript.exe'; " ^
  "$s1.Arguments = '\"%~dp0Launch-GUI.vbs\"'; " ^
  "$s1.WorkingDirectory = '%~dp0'; " ^
  "$s1.Description = 'ICAO Runway Tester Visual GUI Launcher'; " ^
  "$s1.Save(); " ^
  "$s2 = $ws.CreateShortcut(\"$desktop\Start ICAO Server.lnk\"); " ^
  "$s2.TargetPath = '%~dp0start-server.bat'; " ^
  "$s2.WorkingDirectory = '%~dp0'; " ^
  "$s2.Description = 'Start ICAO Runway Tester Server'; " ^
  "$s2.Save(); " ^
  "$s3 = $ws.CreateShortcut(\"$desktop\Stop ICAO Server.lnk\"); " ^
  "$s3.TargetPath = '%~dp0stop-server.bat'; " ^
  "$s3.WorkingDirectory = '%~dp0'; " ^
  "$s3.Description = 'Stop ICAO Runway Tester Server'; " ^
  "$s3.Save();"

echo.
echo [SUCCESS] Shortcuts created on your Desktop:
echo   - ICAO Runway Tester (GUI)
echo   - Start ICAO Server
echo   - Stop ICAO Server
echo.
timeout /t 3 >nul
