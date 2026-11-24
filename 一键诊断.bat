@echo off
setlocal
cd /d "%~dp0"
node scripts\runtime-control.mjs doctor --audit
set "DIAGNOSIS_EXIT=%ERRORLEVEL%"
node scripts\runtime-control.mjs status
echo.
echo Read-only diagnosis complete. No configuration, database or build changes were made.
pause
exit /b %DIAGNOSIS_EXIT%
