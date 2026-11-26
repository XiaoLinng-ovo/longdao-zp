import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
// Use .NET directly: PowerShell module autoload failures must never imply a successful ACL check.
const verifyScript = String.raw`$ErrorActionPreference='Stop'; try {
  $p=$env:RECOVERY_PRIVATE_PATH; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $directory=[IO.Directory]::Exists($p)
  if($directory){$a=[IO.Directory]::GetAccessControl($p)}else{$a=[IO.File]::GetAccessControl($p)}
  if(-not $a.AreAccessRulesProtected){exit 2}
  $allowed=$false; $full=[Security.AccessControl.FileSystemRights]::FullControl
  foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if($r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $r.IdentityReference.Value -ne $sid.Value){exit 3}
    if(($r.FileSystemRights -band $full) -eq $full -and $r.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None){
      if(-not $directory -or ($r.InheritanceFlags -band 3) -eq 3){$allowed=$true}
    }
  }
  if(-not $allowed){exit 4}
} catch {exit 5}`

async function privatePathInfo(path) {
  if (!isAbsolute(path)) throw new Error('RECOVERY_ACL_PATH: An absolute path is required')
  const info = await lstat(path)
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('RECOVERY_ACL_PATH: Ordinary file or directory required')
  return info
}

export async function verifyRecoveryPath(path) {
  const info = await privatePathInfo(path)
  if (process.platform !== 'win32') {
    if (info.uid !== process.getuid() || (info.mode & 0o777) !== (info.isDirectory() ? 0o700 : 0o600)) throw new Error('RECOVERY_ACL_UNSAFE')
    return
  }
  try {
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', verifyScript], {
      windowsHide: true, timeout: 15000, env: { ...process.env, RECOVERY_PRIVATE_PATH: path },
    })
  } catch { throw new Error('RECOVERY_ACL_UNSAFE: Independent owner-only permission verification failed') }
}

export async function protectRecoveryPath(path) {
  const info = await privatePathInfo(path)
  if (process.platform !== 'win32') await chmod(path, info.isDirectory() ? 0o700 : 0o600)
  else {
    try {
      const { stdout } = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 15000 })
      const sid = stdout.match(/S-1-\d+(?:-\d+)+/u)?.[0]
      if (!sid) throw new Error('SID_UNAVAILABLE')
      await execute('icacls.exe', [path, '/inheritance:r', '/grant:r', '*' + sid + ':' + (info.isDirectory() ? '(OI)(CI)' : '') + 'F'], { windowsHide: true, timeout: 15000 })
    } catch { throw new Error('RECOVERY_ACL_FAILED: Cannot establish private recovery permissions') }
  }
  await verifyRecoveryPath(path)
}

export async function writePrivateRecoveryFile(path, bytes) {
  await verifyRecoveryPath(dirname(path))
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  await protectRecoveryPath(path)
}

export async function preparePrivateRecoveryDirectory(directory) {
  try { await mkdir(directory, { mode: 0o700 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    await verifyRecoveryPath(directory)
    return
  }
  await protectRecoveryPath(directory)
}
