import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const contractUrl = new URL('./structure-contract.json', import.meta.url)
// These audited bodies contain no string literals spanning a physical newline.
const legacyLineEndingFunctions = new Set([
  'enforce_live_session_scheduled_interview()',
  'invalidate_interview_summary()',
  'organization_service_available(target_id uuid)',
  'prevent_interview_transcript_version_update()',
  'queue_interview_transcript_postprocess_on_completion()',
  'set_updated_at()',
])

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function objectSignature(row, schema) {
  if (!row) return undefined
  const detail = { ...row.detail }
  if (row.kind === 'relation' && Array.isArray(detail.constraints)) {
    // PostgreSQL orders constraint signatures using the database's collation.
    detail.constraints = detail.constraints.map(canonical).map(item => JSON.stringify(item)).sort()
  }
  if (schema === 'public' && row.kind === 'function' && legacyLineEndingFunctions.has(row.name) && typeof detail.source === 'string') {
    detail.source = detail.source.replaceAll('\r\n', '\n')
  }
  return JSON.stringify(canonical({ ...row, detail }))
}

export function normalizeStructure(rows, schema, organizationId) {
  const normalize = value => {
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
    if (typeof value !== 'string' || schema === 'public') return value
    return value.replaceAll(schema, '__company__').replaceAll(organizationId, '__organization__')
  }
  return rows.filter(row => row.schema === schema).map(({ kind, name, detail }) => ({ kind, name, detail: normalize(detail) }))
    .sort((a, b) => (a.kind + '\0' + a.name).localeCompare(b.kind + '\0' + b.name, 'en'))
}

// One catalog statement in the caller's read-only snapshot. No OIDs, owners or runtime counters in signatures.
export async function captureStructure(client, schemas) {
  return (await client.query(`/* schema-contract */ SELECT n.nspname AS schema,'relation' AS kind,c.relname AS name,
    jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'row_security',c.relrowsecurity,'force_row_security',c.relforcerowsecurity,
      'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
        'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),
        'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END) ORDER BY a.attname)
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
      'constraints',COALESCE((SELECT jsonb_agg(v.signature ORDER BY v.signature::text) FROM
        (SELECT jsonb_build_object('type',x.contype,'definition',pg_get_constraintdef(x.oid),'validated',x.convalidated,
          'deferrable',x.condeferrable,'deferred',x.condeferred,'no_inherit',x.connoinherit) AS signature
         FROM pg_constraint x WHERE x.conrelid=c.oid) v),'[]'::jsonb),
      'indexes',COALESCE((SELECT jsonb_agg(v.signature ORDER BY v.signature::text) FROM
        (SELECT jsonb_build_object('definition',substring(pg_get_indexdef(i.indexrelid) FROM ' USING .*$'),
          'unique',i.indisunique,'primary',i.indisprimary,'exclusion',i.indisexclusion,'valid',i.indisvalid,
          'ready',i.indisready,'live',i.indislive,'nulls_not_distinct',i.indnullsnotdistinct) AS signature
         FROM pg_index i WHERE i.indrelid=c.oid) v),'[]'::jsonb),
      'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,
        'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'[]'::jsonb),
      'policies',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
        'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid),
        'roles',ARRAY(SELECT CASE WHEN role_id=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_id)::text END FROM unnest(p.polroles) role_id ORDER BY role_id)) ORDER BY p.polname)
        FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb),
      'rules',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',r.rulename,'enabled',r.ev_enabled,'definition',pg_get_ruledef(r.oid)) ORDER BY r.rulename)
        FROM pg_rewrite r WHERE r.ev_class=c.oid),'[]'::jsonb),
      'view',CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid) ELSE NULL END) AS detail
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p','v','m','f')
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
    UNION ALL SELECT n.nspname,'function',p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
      jsonb_build_object('kind',p.prokind,'language',l.lanname,'source',p.prosrc,'binary',p.probin,'returns',pg_get_function_result(p.oid),
        'volatility',p.provolatile,'security_definer',p.prosecdef,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,
        'configuration',p.proconfig,'defaults',pg_get_expr(p.proargdefaults,0))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    UNION ALL SELECT n.nspname,'sequence',c.relname,jsonb_build_object('type',format_type(s.seqtypid,NULL),'start',s.seqstart,
      'increment',s.seqincrement,'min',s.seqmin,'max',s.seqmax,'cache',s.seqcache,'cycle',s.seqcycle)
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[])
    UNION ALL SELECT n.nspname,'type',t.typname,jsonb_build_object('kind',t.typtype,'base',format_type(t.typbasetype,t.typtypmod),
      'not_null',t.typnotnull,'default',pg_get_expr(t.typdefaultbin,0),
      'enum',ARRAY(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid=t.oid ORDER BY e.enumsortorder),
      'constraints',ARRAY(SELECT pg_get_constraintdef(x.oid) FROM pg_constraint x WHERE x.contypid=t.oid ORDER BY pg_get_constraintdef(x.oid)))
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=ANY($1::text[]) AND t.typtype IN ('e','d')
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')`, [schemas])).rows
}

export async function migrationSignatures(files) {
  return Promise.all(files.map(async file => ({ version: file.version, name: file.name,
    sha256: createHash('sha256').update(await readFile(file.path)).digest('hex') })))
}

export async function readStructureContract(files) {
  const contract = JSON.parse(await readFile(contractUrl, 'utf8'))
  if (contract.format !== 1 || JSON.stringify(await migrationSignatures(files)) !== JSON.stringify(contract.migrations)) {
    throw new Error('发布门禁：结构契约与工作区迁移 SQL 不一致，须在隔离库审查并重新验收；不能推定历史 SQL 已获证明')
  }
  return contract
}

export function compareStructure(actual, expected, schema) {
  const objects = new Map(actual.map(row => [row.kind + ':' + row.name, row]))
  for (const row of expected) {
    const key = row.kind + ':' + row.name
    if (objectSignature(objects.get(key), schema) !== objectSignature(row, schema)) {
      throw new Error('发布门禁：结构契约不匹配 ' + schema + '.' + key)
    }
    objects.delete(key)
  }
  if (objects.size) throw new Error('发布门禁：结构契约发现未登记对象 ' + schema + '.' + objects.keys().next().value)
}

export async function assertStructureContract(client, contract, companies) {
  const rows = await captureStructure(client, ['public', ...companies.map(company => company.schema_name), ...(contract.control ? ['recovery_control'] : [])])
  compareStructure(normalizeStructure(rows, 'public'), contract.public, 'public')
  if (contract.control) {
    compareStructure(normalizeStructure(rows, 'recovery_control'), contract.control, 'recovery_control')
    await assertRecoveryControlAccess(client)
  }
  for (const company of companies) {
    compareStructure(normalizeStructure(rows, company.schema_name, company.organization_id), contract.company, company.schema_name)
  }
}

export async function assertRecoveryControlAccess(client) {
  const grants = await client.query(
    "SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='recovery_control' AND a.grantee<>n.nspowner UNION ALL " +
    "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE n.nspname='recovery_control' AND a.grantee<>c.relowner UNION ALL " +
    "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='recovery_control' AND a.grantee<>p.proowner LIMIT 1")
  if (grants.rowCount) throw new Error('DATA_CONTROL_ACCESS_UNSAFE')
}
