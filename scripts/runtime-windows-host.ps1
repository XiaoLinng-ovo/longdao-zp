param(
  [ValidateSet('install', 'status', 'remove')][string]$Action = 'status',
  [Parameter(Mandatory = $true)][string]$StateDirectory,
  [Parameter(Mandatory = $true)][string]$ProfilePath
)
$ErrorActionPreference = 'Stop'
$state = [IO.Path]::GetFullPath($StateDirectory)
$profile = [IO.Path]::GetFullPath($ProfilePath)
$hash = [Security.Cryptography.SHA256]::Create()
try { $identity = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($state.ToLowerInvariant())))).Replace('-', '').Substring(0, 12).ToLowerInvariant() }
finally { $hash.Dispose() }
$name = 'SmartRecruit-' + $identity
$description = 'SmartRecruit managed instance ' + $state
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing -and $existing.Description -ne $description) { throw 'TASK_IDENTITY: Refusing to modify an unrelated task.' }
if ($Action -eq 'status') {
  if ($existing) { $existing | Select-Object TaskName, State, Description; Get-ScheduledTaskInfo -TaskName $name }
  else { Write-Output 'NOT_INSTALLED: No logon hosting task for this instance.' }
  exit 0
}
if ($Action -eq 'remove') {
  if ($existing) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
  Write-Output 'Removed logon task only; running services were not stopped.'
  exit 0
}
if ($existing) { throw 'TASK_EXISTS: Inspect/remove the existing owned task before installing a new definition.' }
if (-not (Test-Path -LiteralPath $profile -PathType Leaf)) { throw 'CONFIG_FILE: Approved profile must already exist.' }
$active = Get-Content -LiteralPath (Join-Path $state 'active-release.json') -Raw | ConvertFrom-Json
$release = [IO.Path]::GetFullPath($active.directory)
$controller = Join-Path $release 'scripts/runtime-control.mjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$previousHome = $env:RUNTIME_HOME
$previousProfile = $env:ENV_FILE_PATH
try {
  $env:RUNTIME_HOME = $state
  $env:ENV_FILE_PATH = $profile
  & $node $controller status
  if ($LASTEXITCODE -ne 0) { throw 'NOT_READY: Install hosting only after the instance has passed full readiness.' }
} finally {
  $env:RUNTIME_HOME = $previousHome
  $env:ENV_FILE_PATH = $previousProfile
}
$quote = { param($value) "'" + $value.Replace("'", "''") + "'" }
$launcher = Join-Path $state 'start-at-logon.ps1'
$content = '$ErrorActionPreference = ''Stop''' + [Environment]::NewLine +
  '$env:RUNTIME_HOME = ' + (& $quote $state) + [Environment]::NewLine +
  '$env:ENV_FILE_PATH = ' + (& $quote $profile) + [Environment]::NewLine +
  '& ' + (& $quote $node) + ' ' + (& $quote $controller) + ' start' + [Environment]::NewLine +
  'exit $LASTEXITCODE' + [Environment]::NewLine
[IO.File]::WriteAllText($launcher, $content, [Text.UTF8Encoding]::new($true))
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '"') -WorkingDirectory $release
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Description $description -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal | Select-Object TaskName, State
Write-Output 'Installed current-user logon recovery. This is not a pre-login Windows service. No credentials were stored in the launcher.'
