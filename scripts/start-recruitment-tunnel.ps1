param(
  [ValidateRange(1, 65535)]
  [int]$Port
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateDirectory = Join-Path $root 'tmp'
$statePath = Join-Path $stateDirectory 'recruitment-http2-tunnel.json'
$logDirectory = Join-Path $root 'logs'
$originHelper = Join-Path $PSScriptRoot 'runtime-tunnel-origin.mjs'
$node = (Get-Command node -ErrorAction Stop).Source
$managedPort = & $node $originHelper --port
if ($LASTEXITCODE -ne 0 -or $managedPort -notmatch '^\d+$') {
  throw 'Cannot identify the managed recruitment web port. Start the complete recruitment runtime first.'
}
if (!$PSBoundParameters.ContainsKey('Port')) { $Port = [int]$managedPort }
if ($Port -ne [int]$managedPort) { throw 'Requested port does not belong to the managed recruitment web service.' }
$origin = "http://127.0.0.1:$Port"

function Sync-TunnelOrigin([string]$Url) {
  Write-Output 'Checking website origin and resume import security; current releases do not reload for a new domain.'
  & $node $originHelper --origin $Url --port $Port
  if ($LASTEXITCODE -ne 0) { throw 'Tunnel origin synchronization failed. This URL is not ready; inspect runtime status and logs.' }
}

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

$reuseUrl = $null
if (Test-Path -LiteralPath $statePath) {
  try {
    $saved = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($saved.processId -match '^\d+$' -and $saved.port -eq $Port -and $saved.protocol -eq 'http2' -and
        $saved.url -match '^https://[a-z0-9-]+\.trycloudflare\.com$') {
      $running = Get-CimInstance Win32_Process -Filter "ProcessId = $($saved.processId)"
      if ($running.Name -eq 'cloudflared.exe' -and $running.CommandLine -match '--protocol\s+http2(?:\s|$)' -and
          $running.CommandLine -notmatch '--http-host-header(?:\s|=)' -and
          $running.CommandLine -match ([regex]::Escape("--url $origin") + '(?:\s|$)') -and (Test-TunnelPage $saved.url)) {
        $reuseUrl = $saved.url
      }
    }
  } catch { Write-Warning 'Saved tunnel is unavailable; starting a new HTTP/2 tunnel.' }
}
if ($reuseUrl) {
  Sync-TunnelOrigin $reuseUrl
  Write-Output "Recruitment HTTP/2 tunnel is ready: $reuseUrl/candidates"
  return
}

$cloudflared = (Get-Command cloudflared.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $stateDirectory, $logDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $logDirectory "recruitment-http2-$stamp.stdout.log"
$stderr = Join-Path $logDirectory "recruitment-http2-$stamp.stderr.log"
# Keep QUIC out of this upload path; a connected UDP tunnel can still stall large request bodies.
# Preserve the public Host so the API can validate same-origin requests.
$tunnel = Start-Process -FilePath $cloudflared -ArgumentList @(
  'tunnel', '--url', $origin, '--protocol', 'http2', '--no-autoupdate'
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
      Sync-TunnelOrigin $url
      Write-Output "Recruitment HTTP/2 tunnel is ready: $url/candidates"
      Write-Output "Log: $stderr"
      return
    }
  }
  Start-Sleep -Milliseconds 500
}
# Preserve a slow connector for inspection; never kill other app or tunnel processes.
throw "Tunnel has not become ready. PID=$($tunnel.Id); inspect $stderr"
