const generatedDirectories = /(?:^|\/)(?:node_modules|dist(?:-[^/]+)?|dist-test|coverage|\.git|\.venv|venv|__pycache__|\.vite|\.cache|\.pnpm-store|\.pytest_cache|\.mypy_cache|\.ruff_cache)(?:\/|$)/iu
const runtimeDirectories = /^(?:(?:apps\/[^/]+|web|packages\/[^/]+)\/)?(?:data|logs|tmp|temp|backups?|uploads|recordings|reports|artifacts|models)(?:\/|$)/iu
const privateFiles = /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]+\.env(?:\.[^/]*)?|\.npmrc|\.pgpass|\.netrc|\.git-credentials|environment-(?:before|after)-release|id_rsa[^/]*|id_ed25519[^/]*|[^/]*(?:credentials|service-account|secrets?|tokens)[^/]*\.json)$/iu
const privateDirectories = /(?:^|\/)(?:\.ssh|\.aws|\.azure|\.kube|\.docker|\.cloudflared|\.wrangler|\.vercel|\.config)(?:\/|$)/iu
const temporaryFiles = /(?:^|\/)(?:_tmp_|\.codex|\.tmp-|tmp-db-check)|\.(?:pem|key|pfx|p12|sqlite3?|db|dump|backup|bak[^.\/]*|log|zip|pdf|docx?|xlsx?|csv|mp3|wav|m4a|ogg|webm|mp4|7z|gz|tar|bin|pyc|pyo|tsbuildinfo)$/iu

export function sourceExclusionReason(path) {
  if (path.includes('\\') || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.')) return 'unsafe-path'
  if (generatedDirectories.test(path)) return 'dependencies-build-or-cache'
  if (runtimeDirectories.test(path)) return 'runtime-data-or-models'
  if (privateDirectories.test(path) || (privateFiles.test(path) && !path.endsWith('.env.example'))) return 'private-configuration'
  if (/^docs\/(?:superpowers|patches|manual-screenshots)\//u.test(path)) return 'historical-plans-patches-or-screenshots'
  if (/^docs\/[^/]*(?:-progress-|-plan-|test-report|\u6d4b\u8bd5\u62a5\u544a)/iu.test(path)) return 'historical-progress-plan-or-test-report'
  if (temporaryFiles.test(path)) return 'temporary-backup-media-or-document'
  return null
}
