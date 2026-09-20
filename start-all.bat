@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  pause
  exit /b 1
)

node scripts\start-all.mjs %*
if errorlevel 1 (
  echo.
  echo Startup failed. Check the messages above.
  pause
  exit /b 1
)

echo.
echo Startup complete.
ping 127.0.0.1 -n 3 >nul
exit /b 0
