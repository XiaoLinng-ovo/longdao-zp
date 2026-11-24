interface Statement {
  start: number
  end: number
  tokens: string[]
}

// Split only SQL-level statements; quoted function bodies and nested comments are opaque.
function statements(sql: string): Statement[] {
  const result: Statement[] = []
  let start = 0, i = 0, tokens: string[] = []
  const quoted = (quote: string, escapes = false) => {
    i++
    while (i < sql.length) {
      if (escapes && sql[i] === '\\') { i += 2; continue }
      if (sql[i] === quote) {
        i++
        if (sql[i] === quote) { i++; continue }
        return
      }
      i++
    }
    throw new Error('MIGRATION_SQL_INVALID: unterminated quoted value')
  }
  while (i < sql.length) {
    const ch = sql[i]!
    if (/\s/.test(ch)) { i++; continue }
    if (sql.startsWith('--', i)) {
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++
      continue
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1
      i += 2
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2 }
        else if (sql.startsWith('*/', i)) { depth--; i += 2 }
        else i++
      }
      if (depth) throw new Error('MIGRATION_SQL_INVALID: unterminated block comment')
      continue
    }
    if ((ch === 'e' || ch === 'E') && sql[i + 1] === "'") {
      i++; quoted("'", true); tokens.push('?'); continue
    }
    if (ch === "'" || ch === '"') { quoted(ch); tokens.push('?'); continue }
    if (ch === '$') {
      const delimiter = /^(?:\$\$|\$[a-z_\u0080-\uffff][a-z0-9_\u0080-\uffff]*\$)/i.exec(sql.slice(i))?.[0]
      if (delimiter) {
        const end = sql.indexOf(delimiter, i + delimiter.length)
        if (end < 0) throw new Error('MIGRATION_SQL_INVALID: unterminated dollar quote')
        i = end + delimiter.length; tokens.push('?'); continue
      }
    }
    if (ch === ';') {
      if (tokens.length) result.push({ start, end: i + 1, tokens })
      start = ++i; tokens = []; continue
    }
    if (/[a-z_\u0080-\uffff]/i.test(ch)) {
      const from = i++
      while (i < sql.length && /[a-z0-9_$\u0080-\uffff]/i.test(sql[i]!)) i++
      tokens.push(sql.slice(from, i).toUpperCase()); continue
    }
    tokens.push(ch); i++
  }
  if (tokens.length) result.push({ start, end: sql.length, tokens })
  return result
}

function transactionControl(tokens: string[]): boolean {
  const [first, second, third] = tokens
  if (['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT', 'RELEASE'].includes(first!)) return true
  if ((first === 'START' || first === 'PREPARE') && second === 'TRANSACTION') return true
  if (first !== 'SET') return false
  const setting = second === 'LOCAL' || second === 'SESSION' ? third : second
  return setting === 'TRANSACTION' || setting === 'CHARACTERISTICS' || setting === 'STANDARD_CONFORMING_STRINGS' || second === '?'
}

/** Keep the runner's transaction authoritative without rewriting historical migration files. */
export function prepareMigrationSql(sql: string): string {
  const parsed = statements(sql)
  const first = parsed[0], last = parsed.at(-1)
  const begins = first && /^BEGIN(?: (?:WORK|TRANSACTION))?$/.test(first.tokens.join(' '))
  const commits = last && /^COMMIT(?: (?:WORK|TRANSACTION))?$/.test(last.tokens.join(' '))
  const wrapped = parsed.length >= 2 && begins && commits
  for (let i = 0; i < parsed.length; i++) {
    if (wrapped && (i === 0 || i === parsed.length - 1)) continue
    if (transactionControl(parsed[i]!.tokens))
      throw new Error('MIGRATION_TRANSACTION_CONTROL: migration must not control the runner transaction or SQL string mode')
  }
  if (!wrapped) return sql
  const blank = (statement: Statement) => sql.slice(statement.start, statement.end).replace(/[^\r\n]/g, ' ')
  return blank(first!) + sql.slice(first!.end, last!.start) + blank(last!) + sql.slice(last!.end)
}
