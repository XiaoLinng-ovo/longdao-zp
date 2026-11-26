import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

export async function auditSingleEnterprise(pool) {
  const db=await pool.connect()
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await db.query("SET LOCAL statement_timeout='30s'")
    const migrated=(await db.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='organization_members' AND column_name='ended_at') AS ready")).rows[0].ready
    const rows=(await db.query(`SELECT u.id,u.email,u.display_name,jsonb_agg(jsonb_build_object('enterpriseId',o.id,'enterpriseName',o.name,'role',m.role,'active',m.is_active,'status',o.status) ORDER BY o.id) AS bindings
      FROM public.organization_members m JOIN public.users u ON u.id=m.user_id JOIN public.organizations o ON o.id=m.organization_id
      `+(migrated ? 'WHERE m.ended_at IS NULL' : '')+` GROUP BY u.id HAVING count(*)>1 ORDER BY u.id`)).rows
    await db.query('COMMIT')
    return {ready:rows.length===0,conflictCount:rows.length,accounts:rows}
  } catch(error) { await db.query('ROLLBACK'); throw error }
  finally { db.release() }
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const root=resolve(import.meta.dirname,'..'),load=file=>import(pathToFileURL(join(root,'apps/api/dist/src',file+'.js')))
  await load('env')
  const {loadDatabaseConfig}=await load('db/config'),{target,...config}=loadDatabaseConfig()
  const require=createRequire(join(root,'apps/api/package.json')), {Pool}=require('pg'),pool=new Pool(config)
  try { const report=await auditSingleEnterprise(pool);console.log(JSON.stringify(report,null,2));if(!report.ready)process.exitCode=1 }
  finally { await pool.end() }
}
