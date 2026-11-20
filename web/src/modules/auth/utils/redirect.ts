export function safeAuthRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\/(?![\\/])/u.test(value) || /[\\\u0000-\u001f]/u.test(value)) return undefined
  if (/^\/(?:login|register|forgot-password)(?:[/?#]|$)/u.test(value)) return undefined
  return value
}
