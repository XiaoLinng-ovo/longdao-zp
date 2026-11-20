# Start the local FunASR service after the Windows user signs in.
# This entry point exits when the service is already healthy, avoiding duplicate listeners.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$healthUrl = 'http://127.0.0.1:10095/health'
$serviceScript = Join-Path $root 'funasr-service\start-funasr.ps1'

try {
  $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
  if ($health.service -eq 'funasr') { exit 0 }
} catch {
  # The service is not ready yet; continue with startup.
}

if (-not (Test-Path -LiteralPath $serviceScript)) {
  throw "FunASR startup script not found: $serviceScript"
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $serviceScript
