import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isolatedEnvironment } from './isolated-environment.mjs'

const execute = promisify(execFile)
const snapshot = String.raw`
$ErrorActionPreference = 'Stop'
$roots = @($env:ISOLATED_SAMPLE_PIDS.Split(',') | ForEach-Object { [int]$_ })
$all = @(Get-CimInstance Win32_Process)
$selected = @{}
$excluded = @{ $PID = $true }
foreach ($item in $all) {
  if ($roots -contains [int]$item.ProcessId) { $selected[[int]$item.ProcessId] = $item }
}
do {
  $changed = $false
  foreach ($item in $all) {
    $key = [int]$item.ProcessId
    $parent = [int]$item.ParentProcessId
    if ($excluded.ContainsKey($parent) -and -not $excluded.ContainsKey($key)) {
      $excluded[$key] = $true
      $changed = $true
    }
    if (-not $excluded.ContainsKey($key) -and -not $selected.ContainsKey($key) -and $selected.ContainsKey($parent) -and $item.CreationDate -ge $selected[$parent].CreationDate) {
      $selected[$key] = $item
      $changed = $true
    }
  }
} while ($changed)
$rows = @()
$vanished = @()
foreach ($item in $selected.Values) {
  if ($excluded.ContainsKey([int]$item.ProcessId)) { continue }
  $current = Get-Process -Id ([int]$item.ProcessId) -ErrorAction SilentlyContinue
  if ($null -eq $current) { $vanished += [int]$item.ProcessId; continue }
  $created = ([DateTime]$item.CreationDate).ToUniversalTime()
  if ([Math]::Abs(($current.StartTime.ToUniversalTime() - $created).TotalMilliseconds) -gt 100) {
    $vanished += [int]$item.ProcessId
    continue
  }
  $rows += @{ pid = $current.Id; parentPid = [int]$item.ParentProcessId; name = $current.ProcessName;
    createdAt = $created.ToString('o'); rssBytes = $current.WorkingSet64; handles = $current.HandleCount;
    cpuSeconds = [double]$current.CPU; readBytes = [long]$item.ReadTransferCount; writeBytes = [long]$item.WriteTransferCount }
}
@{ at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); roots = @($roots); processes = @($rows);
  vanished = @($vanished); missingRoots = @($roots | Where-Object { $rows.pid -notcontains $_ }) } | ConvertTo-Json -Depth 5 -Compress
`
export async function measureIsolatedProcessTree(roots) {
  assert.equal(process.platform, 'win32', '当前进程树采样器仅支持Windows，其他平台不能伪造证据')
  assert.ok(Array.isArray(roots) && roots.length > 0 && roots.every(pid => Number.isSafeInteger(pid) && pid > 0))
  const powershell = join(process.env.SYSTEMROOT ?? process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const result = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', snapshot],
    { windowsHide: true, env: isolatedEnvironment({ ISOLATED_SAMPLE_PIDS: [...new Set(roots)].join(',') }), timeout: 15000, maxBuffer: 1024 * 1024 })
  assert.equal(result.stderr, '', '进程树采样存在标准错误输出')
  const value = JSON.parse(result.stdout.replace(/^\uFEFF/, ''))
  assert.deepEqual(value.missingRoots, [], '受测根进程已消失或PID身份变更')
  assert.ok(value.processes.length >= new Set(roots).size)
  assert.equal(new Set(value.processes.map(row => row.pid)).size, value.processes.length)
  for (const row of value.processes) {
    for (const key of ['rssBytes', 'handles', 'cpuSeconds', 'readBytes', 'writeBytes']) assert.ok(Number.isFinite(row[key]) && row[key] >= 0)
  }
  return { ...value, rssBytes: value.processes.reduce((total, row) => total + row.rssBytes, 0),
    observationLimit: '定期枚举全部后代并按创建时间核对PID；两次采样之间已退出的短命进程可能漏检；不读取命令行或环境' }
}
