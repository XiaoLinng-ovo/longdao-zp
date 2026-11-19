import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import { prepareMigrationSql } from './migration-sql.js'

test('all real migrations are accepted and only the historical outer transaction is removed', async () => {
  const directory = fileURLToPath(new URL('../../../../../db/migrations/', import.meta.url))
  const changed: string[] = []
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql'))) {
    const sql = await readFile(join(directory, name), 'utf8'), prepared = prepareMigrationSql(sql)
    assert.equal(prepared.split('\n').length, sql.split('\n').length)
    if (prepared !== sql) changed.push(name)
  }
  assert.deepEqual(changed, ['0035_subscription_entitlements.sql'])
})

test('comments, dollar-quoted function bodies, quoted identifiers and strings stay intact', () => {
  const body = String.raw`CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $tag$ BEGIN RAISE NOTICE 'COMMIT;'; END; $tag$;
DO $$ BEGIN NULL; END; $$;
SELECT 'it''s; BEGIN;', E'escaped\'; COMMIT;', "COMMIT;", U&'quoted;';
/* outer /* BEGIN; */ COMMIT; */ -- ROLLBACK;
SELECT 1;`
  assert.equal(prepareMigrationSql(body), body)
  const input = '-- wrapper\nBEGIN WORK;\n' + body + '\nCOMMIT TRANSACTION; -- suffix'
  const prepared = prepareMigrationSql(input)
  assert.ok(prepared.includes(body))
  assert.ok(prepared.endsWith(' -- suffix'))
  assert.equal(prepared.length, input.length)
})

for (const control of ['COMMIT', 'END', 'ROLLBACK', 'ABORT', 'BEGIN', 'SAVEPOINT x', 'RELEASE x',
  'START TRANSACTION', "PREPARE TRANSACTION 'x'", 'SET TRANSACTION READ ONLY',
  'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', 'SET LOCAL standard_conforming_strings=off',
  'SET "standard_conforming_strings"=off', 'COMMIT AND CHAIN']) {
  test('reject transaction escape: ' + control, () => {
    for (const sql of [control + ';', 'BEGIN; SELECT 1; ' + control + '; COMMIT;'])
      assert.throws(() => prepareMigrationSql(sql), /MIGRATION_TRANSACTION_CONTROL/)
  })
}

test('incomplete wrappers and malformed lexical input fail before execution', () => {
  for (const sql of ['BEGIN; SELECT 1;', 'SELECT 1; COMMIT;', "SELECT 'unterminated", 'DO $x$ unterminated', '/* unfinished'])
    assert.throws(() => prepareMigrationSql(sql), /MIGRATION_TRANSACTION_CONTROL|MIGRATION_SQL_INVALID/)
  assert.equal(prepareMigrationSql("SELECT 'BEGIN; COMMIT;';"), "SELECT 'BEGIN; COMMIT;';")
})
