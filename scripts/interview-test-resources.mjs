import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export function assertInterviewTestMemory(snapshot, minimumCommitMb = 6144) {
  assert.ok(Number.isSafeInteger(minimumCommitMb) && minimumCommitMb >= 1024 && minimumCommitMb <= 65536, 'Invalid acceptance memory threshold')
  const freeCommitMb = Number(snapshot.FreeVirtualMemory) / 1024
  const freePhysicalMb = Number(snapshot.FreePhysicalMemory) / 1024
  assert.ok(Number.isFinite(freeCommitMb) && Number.isFinite(freePhysicalMb), 'Cannot establish available memory; do not start heavy speech acceptance')
  assert.ok(freeCommitMb >= minimumCommitMb && freePhysicalMb >= 1024,
    `INTERVIEW_TEST_MEMORY_PRESSURE: free virtual memory ${Math.floor(freeCommitMb)} MiB; free physical memory ${Math.floor(freePhysicalMb)} MiB. Need at least ${minimumCommitMb} MiB virtual and 1024 MiB physical before heavy acceptance. No services were stopped.`)
  return { freeCommitMb: Math.floor(freeCommitMb), freePhysicalMb: Math.floor(freePhysicalMb), minimumCommitMb }
}

export async function requireInterviewTestMemory() {
  if (process.platform !== 'win32') return { supported: false }
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,FreeVirtualMemory | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 15000 })
  return { supported: true, ...assertInterviewTestMemory(JSON.parse(stdout)) }
}
