export function virusScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.RESUME_VIRUS_SCAN_ENABLED?.trim().toLowerCase()
  if (configured === 'true') return true
  if (configured === 'false') return false
  return false
}

export function initialResumeScanStatus(env: NodeJS.ProcessEnv = process.env): 'clean' | 'quarantined' {
  return virusScanEnabled(env) ? 'quarantined' : 'clean'
}
