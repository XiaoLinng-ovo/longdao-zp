param(
  [ValidateRange(1, 65535)]
  [int]$Port = 5174
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$origin = "http://127.0.0.1:$Port"
$stateDirectory = Join-Path $root 'tmp'
$statePath = Join-Path $stateDirectory 'recruitment-http2-tunnel.json'
$logDirectory = Join-Path $root 'logs'

function Test-TunnelPage([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri "$Url/api/v1/health" -TimeoutSec 10 -UseBasicParsing
    $body = $response.Content | ConvertFrom-Json
    return $body.ok -eq $true -and $body.data.service -eq 'smartrecruit-pro-api'
  } catch { return $false }
}

if (!(Test-TunnelPage $origin)) {
  throw "Recruitment API is not reachable through $origin. Start the local recruitment app first."
}

if (Test-Path -LiteralPath $statePath) {
  try {
    $saved = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($saved.processId -match '^\d+$' -and $saved.port -eq $Port -and $saved.protocol -eq 'http2' -and
        $saved.url -match '^https://[a-z0-9-]+\.trycloudflare\.com$') {
      $running = Get-CimInstance Win32_Process -Filter "ProcessId = $($saved.processId)"
      if ($running.Name -eq 'cloudflared.exe' -and $running.CommandLine -match '--protocol\s+http2(?:\s|$)' -and
          $running.CommandLine -match ([regex]::Escape("--url $origin") + '(?:\s|$)') -and (Test-TunnelPage $saved.url)) {
        Write-Output "Recruitment HTTP/2 tunnel is ready: $($saved.url)/candidates"
        return
      }
    }
  } catch { Write-Warning 'Saved tunnel is unavailable; starting a new HTTP/2 tunnel.' }
}

$cloudflared = (Get-Command cloudflared.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $stateDirectory, $logDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $logDirectory "recruitment-http2-$stamp.stdout.log"
$stderr = Join-Path $logDirectory "recruitment-http2-$stamp.stderr.log"
# Keep QUIC out of this upload path; a connected UDP tunnel can still stall large request bodies.
$tunnel = Start-Process -FilePath $cloudflared -ArgumentList @(
  'tunnel', '--url', $origin, '--http-host-header', 'localhost', '--protocol', 'http2', '--no-autoupdate'
) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  $tunnel.Refresh()
  if ($tunnel.HasExited) { throw "Tunnel exited. Inspect $stderr" }
  if (Test-Path -LiteralPath $stderr) {
    $content = [string](Get-Content -LiteralPath $stderr -Raw)
    $url = [regex]::Match($content, 'https://[a-z0-9-]+\.trycloudflare\.com').Value
    if ($url -and $content -match 'Registered tunnel connection.*protocol=http2' -and (Test-TunnelPage $url)) {
      @{ processId = $tunnel.Id; port = $Port; protocol = 'http2'; url = $url; stdout = $stdout; stderr = $stderr } |
        ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
      Write-Output "Recruitment HTTP/2 tunnel is ready: $url/candidates"
      Write-Output "Log: $stderr"
      return
    }
  }
  Start-Sleep -Milliseconds 500
}
# Preserve a slow connector for inspection; never kill other app or tunnel processes.
throw "Tunnel has not become ready. PID=$($tunnel.Id); inspect $stderr"
