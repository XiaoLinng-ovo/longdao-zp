# 本地 FunASR 服务启动脚本
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw "FunASR Python 虚拟环境不存在: $python" }
& $python -m uvicorn server:app --host 127.0.0.1 --port 10095
