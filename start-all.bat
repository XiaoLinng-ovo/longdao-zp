@echo off
setlocal
cd /d "%~dp0"

set "ELEVATED="
if /I "%~1"=="--elevated" set "ELEVATED=1"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  pause
  exit /b 1
)

node scripts\start-all.mjs %*
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="10" (
  if defined ELEVATED (
    echo.
    echo PostgreSQL could not be started even with administrator privileges.
    echo Set the PostgreSQL Windows service to Automatic, then try again.
    pause
    exit /b 1
  )
  echo.
  echo PostgreSQL needs administrator privileges. Requesting elevation...
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '--elevated' -Verb RunAs"
  exit /b 0
)

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Startup failed. Check the messages above.
  pause
  exit /b %EXIT_CODE%
)

echo.
echo Startup complete.
ping 127.0.0.1 -n 3 >nul
exit /b 0
