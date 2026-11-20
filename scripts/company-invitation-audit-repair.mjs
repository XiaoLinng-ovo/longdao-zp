import assert from 'node:assert/strict'
import {inspectCompanyData} from './check-company-schemas.mjs'
import {fingerprintTables,verifyTableFingerprints} from './recovery-snapshot.mjs'
import {fingerprintSelection} from './company-data-model.mjs'

// Deliberately limited to the three reviewed, real membership audit events.
export const auditRepairOrganization = '2194494b-b673-468e-be83-1bfe6710fc2f'
export const auditRepairSchema = 'company_2194494bb673468ebe831bfe6710fc2f'
export const auditRepairRows = [
  {id:'5dba624e-0198-4f8d-8299-a29b6f8d4190',action:'workspace.member.transfer',sha256:'8062af650c7d1736953a6f087cd7b4629ede9626e6967247ebfb5d90da19faae'},
  {id:'ac090fef-f3f7-4436-8bc2-6a33e0da6a1e',action:'workspace.invitation.accept',sha256:'580fc161c9bc22bd7113e79057a930bc24d7eac45f4a56add213813a0fee307b'},
  {id:'eb89aa0f-d31d-4e92-9217-f5c22aeb252d',action:'workspace.invitation.create',sha256:'030740ea277e2d63fbbd0f24ba9cb190a14d79ab7be1d91f32172e601da5d972'},
]

// Caller owns a REPEATABLE READ transaction and commits only after saving evidence.
export async function repairReviewedInvitationAudits(client) {
  const schema=auditRepairSchema,org=auditRepairOrganization,ids=auditRepairRows.map(row=>row.id)
  await client.query("SET LOCAL lock_timeout='5s'")
  await client.query("SET LOCAL statement_timeout='120s'")
  await client.query('LOCK TABLE recovery_control.company_data_cutovers IN SHARE MODE')
  await client.query('LOCK TABLE public.audit_logs,"'+schema+'".audit_logs IN SHARE ROW EXCLUSIVE MODE')
  assert.equal((await client.query('SELECT public.read_company_data_cutover($1) AS cutover',[org])).rows[0].cutover,null,'Sealed snapshots cannot be repaired')
  const columns=await client.query("SELECT table_schema,array_agg(column_name::text ORDER BY ordinal_position) AS names FROM information_schema.columns WHERE table_name='audit_logs' AND table_schema=ANY($1) GROUP BY table_schema ORDER BY table_schema",[['public',schema]])
  assert.equal(columns.rows.length,2)
  assert.deepEqual(columns.rows[0].names,columns.rows[1].names)
  const triggers=(await client.query("SELECT n.nspname AS schema,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND c.relname='audit_logs' AND n.nspname=ANY($1) ORDER BY n.nspname,t.tgname",[['public',schema]])).rows
  assert.equal(triggers.length,4,'Unexpected audit triggers')
  assert.ok(triggers.every(t=>['company_legacy_snapshot_guard','company_legacy_snapshot_no_truncate'].includes(t.tgname)&&t.definition.includes('guard_company_legacy_snapshot()')))
  const beforeCheck=await inspectCompanyData(client,{compareLegacy:true,classifyKeys:true,includeEntries:true})
  const differences=beforeCheck.companies.flatMap(c=>c.differences.map(d=>({organizationId:c.organization_id,...d})))
  assert.equal(differences.length,1,'Only the reviewed audit difference may be repaired')
  const difference=differences[0]
  assert.equal(difference.organizationId,org);assert.equal(difference.table,'audit_logs')
  assert.equal(difference.companyOnly,3);assert.equal(difference.legacyOnly,0);assert.equal(difference.conflicting,0)
  assert.deepEqual(difference.entries.map(e=>({id:e.primaryKey[0],sha256:e.companyHash})),auditRepairRows.map(({id,sha256})=>({id,sha256})))
  const provenance=(await client.query('SELECT a.id,a.action,a.organization_id,(u.id IS NOT NULL) AS actor_exists,CASE WHEN a.resource_type=\'organization_member\' THEN m.user_id IS NOT NULL WHEN a.resource_type=\'organization_invitation\' THEN i.id IS NOT NULL AND i.organization_id=a.organization_id ELSE false END AS resource_exists FROM "'+schema+'".audit_logs a LEFT JOIN public.users u ON u.id=a.actor_user_id LEFT JOIN public.organization_invitations i ON i.id=a.resource_id LEFT JOIN public.organization_members m ON m.organization_id=a.organization_id AND m.user_id=a.resource_id WHERE a.id=ANY($1::uuid[]) ORDER BY a.id',[ids])).rows
  assert.deepEqual(provenance.map(({id,action})=>({id,action})),auditRepairRows.map(({id,action})=>({id,action})))
  assert.ok(provenance.every(row=>row.organization_id===org&&row.actor_exists&&row.resource_exists),'Audit provenance mismatch')
  assert.equal((await client.query('SELECT id FROM public.audit_logs WHERE id=ANY($1::uuid[])',[ids])).rowCount,0)
  const before=await fingerprintTables(client)
  const oldPublic=await fingerprintSelection(client,'SELECT * FROM public.audit_logs WHERE NOT(id=ANY($1::uuid[]))',[ids])
  const source=(await client.query('SELECT to_jsonb(a)::text AS row FROM "'+schema+'".audit_logs a WHERE a.id=ANY($1::uuid[]) ORDER BY a.id',[ids])).rows.map(r=>r.row)
  const copied=await client.query('INSERT INTO public.audit_logs SELECT * FROM "'+schema+'".audit_logs WHERE id=ANY($1::uuid[]) AND organization_id=$2 RETURNING id',[ids,org])
  assert.equal(copied.rowCount,3)
  assert.equal((await client.query('SELECT c.id FROM "'+schema+'".audit_logs c JOIN public.audit_logs p USING(id) WHERE c.id=ANY($1::uuid[]) AND to_jsonb(c)=to_jsonb(p)',[ids])).rowCount,3)
  assert.deepEqual(await fingerprintSelection(client,'SELECT * FROM public.audit_logs WHERE NOT(id=ANY($1::uuid[]))',[ids]),oldPublic,'Existing public audits changed')
  const after=await fingerprintTables(client)
  const notPublicAudit=t=>t.schema!=='public'||t.name!=='audit_logs'
  verifyTableFingerprints(before.filter(notPublicAudit),after.filter(notPublicAudit))
  assert.equal(BigInt(after.find(t=>!notPublicAudit(t)).rows),BigInt(before.find(t=>!notPublicAudit(t)).rows)+3n)
  const check=await inspectCompanyData(client,{compareLegacy:true})
  assert.equal(check.ready,true,'All company checks must pass after exact copies')
  return {inserted:copied.rowCount,ids,source,before,after,check,triggers,noDeletion:true,noCutoverChange:true,noOtherTableChanged:true}
}

