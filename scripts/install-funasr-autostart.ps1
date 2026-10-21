# Install or update the SmartRecruit local FunASR logon task.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'scripts\start-funasr-on-login.ps1'
if (-not (Test-Path -LiteralPath $entry)) { throw "Autostart script not found: $entry" }

$taskName = 'SmartRecruit-FunASR-AutoStart'
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$entry`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $root
$identity = "$env:USERDOMAIN\$env:USERNAME"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Start SmartRecruit local FunASR transcription after logon.' -Force | Out-Null
Write-Host "Installed logon task: $taskName"
Write-Host "Entry point: $entry"
