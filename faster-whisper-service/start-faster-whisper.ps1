$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$envFile = Join-Path $PSScriptRoot '..\.env'
if (Test-Path -LiteralPath $envFile) {
  foreach ($rawLine in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $separator = $line.IndexOf('=')
    if ($separator -le 0) { continue }
    $key = $line.Substring(0, $separator).Trim()
    if ($key -notmatch '^FASTER_WHISPER_[A-Z0-9_]+$' -or $null -ne [Environment]::GetEnvironmentVariable($key, 'Process')) { continue }
    $value = $line.Substring($separator + 1).Trim()
    if ($value.Length -ge 2) {
      $first = $value[0]
      $last = $value[$value.Length - 1]
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }
    [Environment]::SetEnvironmentVariable($key, $value, 'Process')
  }
}

$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw "faster-whisper Python 虚拟环境不存在: $python" }
& $python -m uvicorn server:app --host 127.0.0.1 --port 10096

exit $LASTEXITCODE
