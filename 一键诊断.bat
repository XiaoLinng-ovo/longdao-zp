@echo off
setlocal
cd /d "%~dp0"

set "LOG=%~dp0start-diagnosis.log"
break > "%LOG%"

call :write "[SmartRecruit diagnosis]"
call :write "Root: %CD%"
call :write ""

call :section "Versions"
call :capture node -v
call :capture npm -v
call :capture pnpm -v

call :section "Required files"
call :capture dir package.json
call :capture dir web\package.json
call :capture dir apps\worker\package.json

call :section "Environment summary"
if exist ".env" (
  call :write ".env exists"
  findstr /B /C:"PGHOST=" /C:"PGPORT=" /C:"PGUSER=" /C:"PGDATABASE=" /C:"S3_ENDPOINT=" /C:"WORKER_DB_POLL=" /C:"OPENAI_BASE_URL=" /C:"OPENAI_MODEL=" ".env" >> "%LOG%" 2>&1
  findstr /B /C:"DATABASE_URL=" ".env" >nul 2>nul && call :write "DATABASE_URL=set" || call :write "DATABASE_URL=not set"
  findstr /B /C:"PGPASSWORD=" ".env" >nul 2>nul && call :write "PGPASSWORD=set" || call :write "PGPASSWORD=not set"
  findstr /B /C:"OPENAI_API_KEY=" ".env" >nul 2>nul && call :write "OPENAI_API_KEY=set" || call :write "OPENAI_API_KEY=not set"
) else (
  call :write ".env missing"
)

call :section "PostgreSQL services"
call :capture powershell.exe -NoProfile -Command "Get-Service -Name '*postgres*' -ErrorAction SilentlyContinue | Select-Object Name,Status | Format-Table -AutoSize"

call :section "Listening ports"
cmd.exe /c "netstat -ano | findstr LISTENING | findstr \":3100 :4001 :5174 :5432\"" >> "%LOG%" 2>&1

call :section "One-click dry run"
call :capture node scripts\start-all.mjs --dry-run

call :section "API build"
call :capture npm --prefix apps\api run build

call :section "Database migration"
call :capture node scripts\migrate-postgres.mjs

call :section "Worker build"
call :capture npm --prefix apps\worker run build

call :section "Web build"
call :capture npm --prefix web run build

echo.
echo Diagnosis written to:
echo   %LOG%
echo.
type "%LOG%"
echo.
pause
exit /b 0

:section
call :write ""
call :write "==== %~1 ===="
exit /b 0

:capture
>> "%LOG%" 2>&1 (
  %*
)
exit /b 0

:write
>> "%LOG%" echo %~1
exit /b 0
