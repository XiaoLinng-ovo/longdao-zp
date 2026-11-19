param(
  [Parameter(Mandatory=$true)][int]$TargetProcessId,
  [Parameter(Mandatory=$true)][string]$StopPath
)
$ErrorActionPreference = 'Stop'
$history = @{}
while (-not (Test-Path -LiteralPath $StopPath)) {
  try {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $TargetProcessId" | Where-Object { $_.ProcessId -ne $PID -and $_.Name -like '*ffmpeg*' })
    $ids = @($TargetProcessId) + @($children | ForEach-Object { [int]$_.ProcessId })
    $rows = @()
    foreach ($processId in $ids) {
      $item = Get-Process -Id $processId -ErrorAction SilentlyContinue
      if ($null -eq $item) { continue }
      $key = [string]$item.Id + ':' + [string]$item.StartTime.ToFileTimeUtc()
      $history[$key] = [double]$item.CPU
      $rows += @{ pid = $item.Id; name = $item.ProcessName; rssBytes = $item.WorkingSet64; handles = $item.HandleCount; cpuSeconds = [double]$item.CPU }
    }
    $readBytes = 0L; $writeBytes = 0L
    foreach ($item in $children) { $readBytes += [long]$item.ReadTransferCount; $writeBytes += [long]$item.WriteTransferCount }
    @{ type = 'sample'; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); processes = @($rows);
      observedCpuSeconds = [double](($history.Values | Measure-Object -Sum).Sum);
      liveChildrenReadBytes = $readBytes; liveChildrenWriteBytes = $writeBytes } | ConvertTo-Json -Depth 5 -Compress
  } catch {
    @{ type = 'sampling-error'; message = $_.Exception.Message } | ConvertTo-Json -Compress
  }
  Start-Sleep -Milliseconds 250
}
try {
  $connections = @(Get-NetTCPConnection -OwningProcess $TargetProcessId -ErrorAction SilentlyContinue)
  @{ type = 'connections'; count = $connections.Count } | ConvertTo-Json -Compress
} catch { @{ type = 'connection-error'; message = $_.Exception.Message } | ConvertTo-Json -Compress }
