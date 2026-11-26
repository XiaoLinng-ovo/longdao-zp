import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir,copyFile } from 'node:fs/promises'
import { listMigrationFiles } from '../packages/database-readiness/index.js'
import { projectRoot as root,startIsolatedPostgres } from './isolated-environment.mjs'
assert.ok(process.argv[2],'Explicit isolated PostgreSQL bin directory required')
const instance=await startIsolatedPostgres(process.argv[2])
for(const key of Object.keys(process.env))delete process.env[key]
Object.assign(process.env,instance.env,{NODE_ENV:'test'})
const require=createRequire(join(root,'apps/api/package.json'))
require(join(root,'scripts/isolated-network-guard.cjs'))
const {Pool}=require('pg'),admin=new Pool(instance.connection)
const load=file=>import(pathToFileURL(join(root,'apps/api/dist/src',file+'.js')))
let pool,created=false
try {
 await admin.query('CREATE DATABASE "'+instance.database+'"');created=true
 pool=new Pool({...instance.connection,database:instance.database,max:8})
 const {runMigrations}=await load('db/migrations'),migrations=join(root,'db/migrations'),baseline=join(instance.directory,'baseline')
 await mkdir(baseline)
 for(const file of await listMigrationFiles(migrations))if(file.version<'0113')await copyFile(file.path,join(baseline,file.name))
 await runMigrations(pool,baseline)
 const user=async label=>{const id=randomUUID();await pool.query('INSERT INTO public.users(id,email,display_name) VALUES($1,$2,$3)',[id,label+'@example.invalid',label]);return id}
 const org=async label=>{const id=randomUUID();await pool.query("INSERT INTO public.organizations(id,name,kind,service_status) VALUES($1,$2,'production','enabled')",[id,label]);return id}
 const a=await org('enterprise-a'),b=await org('enterprise-b'),owner=await user('owner'),otherOwner=await user('other-owner'),member=await user('member'),fresh=await user('fresh')
 await pool.query("INSERT INTO public.organization_members(organization_id,user_id,role) VALUES($1,$3,'owner'),($2,$4,'owner'),($1,$5,'member'),($2,$5,'member')",[a,b,owner,otherOwner,member])
 const {auditSingleEnterprise}=await import('./audit-single-enterprise.mjs')
 assert.equal((await auditSingleEnterprise(pool)).conflictCount,1)
 await assert.rejects(runMigrations(pool,migrations),/MULTIPLE_ENTERPRISE_BINDINGS/)
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='organization_members' AND column_name='ended_at'")).rows[0].n,1)
 const {resolveSingleEnterprise}=await import('./resolve-single-enterprise.mjs')
 const plan=[{organizationId:b,userId:member,actorId:otherOwner,replacementId:otherOwner,keepOrganizationId:a,reason:'explicit conflict resolution'}]
 assert.equal((await resolveSingleEnterprise(pool,plan,{routeSchemas:false})).dryRun,true)
 assert.equal((await auditSingleEnterprise(pool)).conflictCount,1)
 await resolveSingleEnterprise(pool,plan,{apply:true,routeSchemas:false})
 await runMigrations(pool,migrations)
 assert.equal((await auditSingleEnterprise(pool)).ready,true)
 console.log('PASS migration refuses unique enforcement on conflicts; audited plan preserves additive structure and resolves explicitly')
 const {WorkspaceInvitationsService}=await load('auth/workspace-invitations'),{WorkspaceOffboardingService}=await load('auth/workspace-offboarding'),{PostgresSessionRepository}=await load('auth/session-repository')
 const service=new WorkspaceInvitationsService(pool,false),offboard=new WorkspaceOffboardingService(pool,false),repository=new PostgresSessionRepository(pool)
 const challenge=await repository.createEmailVerificationChallenge({purpose:'registration',email:'unbound@example.invalid',codeHash:'a'.repeat(64),expiresInMs:600000,maxAttempts:5})
 assert.ok(challenge.challenge)
 const registered=await repository.registerUserWithVerification({name:'Unbound User',email:'unbound@example.invalid',password:'synthetic-password'},{codeHash:'a'.repeat(64)})
 assert.equal(registered.workspace,undefined)
 assert.equal((await repository.listWorkspaces(registered.user.id)).length,0)
 console.log('PASS verified ordinary registration creates an account without an enterprise')
 const inviteA=await service.create(a,owner,{}),inviteB=await service.create(b,otherOwner,{})
 await assert.rejects(service.accept(inviteB.code,member),{code:'ACCOUNT_ALREADY_BOUND'})
 await assert.rejects(repository.createWorkspace(member,{name:'second-enterprise',kind:'test'}),{code:'ACCOUNT_ALREADY_BOUND'})
 await service.accept(inviteA.code,member)
 await service.setMemberStatus(a,owner,member,{isActive:false,reason:'synthetic suspension'})
 assert.equal((await repository.listWorkspaces(member))[0].membershipActive,false)
 await assert.rejects(service.accept(inviteA.code,member),{code:'MEMBERSHIP_DISABLED'})
 await assert.rejects(service.accept(inviteB.code,member),{code:'ACCOUNT_ALREADY_BOUND'})
 await service.setMemberStatus(a,owner,member,{isActive:true,reason:'synthetic restoration'})
 console.log('PASS same-enterprise joins are idempotent; disabled memberships cannot escape affiliation')
 const races=await Promise.allSettled([service.accept(inviteA.code,fresh),service.accept(inviteB.code,fresh),repository.createWorkspace(fresh,{name:'race-enterprise',kind:'production'})])
 assert.equal(races.filter(r=>r.status==='fulfilled').length,1)
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.organization_members WHERE user_id=$1 AND ended_at IS NULL',[fresh])).rows[0].n,1)
 console.log('PASS concurrent invite/invite/create leaves exactly one affiliation')
 await assert.rejects(pool.query("INSERT INTO public.organization_members(organization_id,user_id,role) VALUES($1,$2,'member')",[b,member]),{code:'23505'})
 const session=(await pool.query("INSERT INTO public.sessions(user_id,token_hash,csrf_token_hash,expires_at,active_organization_id) VALUES($1,'synthetic-token','synthetic-csrf',now()+interval '1 hour',$2) RETURNING id",[member,a])).rows[0].id
 const job=randomUUID(),candidate=randomUUID(),application=randomUUID(),interview=randomUUID()
 await pool.query("INSERT INTO public.jobs(id,job_no,title,headcount,organization_id,hiring_manager_names) VALUES($1,'JOB-OFF','job',1,$2,$3)",[job,a,member])
 await pool.query("INSERT INTO public.candidates(id,candidate_no,name,organization_id) VALUES($1,'CAN-OFF','candidate',$2)",[candidate,a])
 await pool.query("INSERT INTO public.applications(id,application_no,candidate_id,job_id,status,recruiter_id,organization_id) VALUES($1,'APP-OFF',$2,$3,'interviewing',$4,$5)",[application,candidate,job,member,a])
 await pool.query("INSERT INTO public.interviews(id,interview_no,application_id,round,type,title,status,participants,organization_id) VALUES($1,'INT-OFF',$2,1,'technical','interview','scheduled',$3,$4)",[interview,application,JSON.stringify([{userId:member,name:'member',role:'interviewer',required:true,lead:true,sheetTypes:['hr_screen']}]),a])
 const beforeSeats=(await pool.query('SELECT seat_usage FROM public.organizations WHERE id=$1',[a])).rows[0].seat_usage
 await offboard.request(a,member,{reason:'synthetic departure'})
 assert.equal((await offboard.list(a,owner)).length,1)
 await assert.rejects(offboard.request(a,owner,{reason:'owner departure'}),{code:'OWNERSHIP_TRANSFER_REQUIRED'})
 await offboard.resolve(a,owner,member,{reason:'approved departure',replacementId:owner})
 assert.equal((await pool.query('SELECT revoked_at FROM public.sessions WHERE id=$1',[session])).rows[0].revoked_at!==null,true)
 assert.equal((await pool.query('SELECT participants FROM public.interviews WHERE id=$1',[interview])).rows[0].participants[0].userId,owner)
 assert.equal((await pool.query('SELECT recruiter_id FROM public.applications WHERE id=$1',[application])).rows[0].recruiter_id,owner)
 assert.equal((await pool.query('SELECT seat_usage FROM public.organizations WHERE id=$1',[a])).rows[0].seat_usage,beforeSeats-1)
 assert.equal((await repository.listWorkspaces(member)).length,0)
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.organization_membership_history WHERE user_id=$1 AND organization_id=$2',[member,a])).rows[0].n,1)
 await service.accept(inviteB.code,member)
 await offboard.resolve(b,otherOwner,member,{reason:'second departure',replacementId:otherOwner})
 await service.accept(inviteA.code,member)
 assert.equal((await pool.query('SELECT role,department_id FROM public.organization_members WHERE organization_id=$1 AND user_id=$2',[a,member])).rows[0].role,'member')
 console.log('PASS departure preserves history, transfers outstanding duties, frees seats, revokes sessions and permits ordinary-member rejoin')
 await pool.query("UPDATE public.organizations SET status='archived' WHERE id=$1",[a])
 await assert.rejects(repository.createWorkspace(member,{name:'archived-bypass',kind:'production'}),{code:'ACCOUNT_ALREADY_BOUND'})
 console.log('PASS archived enterprise does not release affiliation')
 const listed=await service.members(a,owner)
 assert.ok(listed.some(m=>m.id===member))
 await offboard.request(a,member,{reason:'archived enterprise exit'})
 await offboard.resolve(a,owner,member,{reason:'request rejected',reject:true})
 assert.equal((await offboard.list(a,owner)).length,0)
 await pool.query("UPDATE public.organizations SET status='active' WHERE id=$1",[a])
 await pool.query('UPDATE public.interviews SET participants=$2::jsonb WHERE id=$1',[interview,JSON.stringify([{userId:member,role:'interviewer',required:true,lead:true,sheetTypes:['hr_screen']}])])
 const schema=(await pool.query('SELECT public.initialize_organization_schema($1) AS name',[a])).rows[0].name
 await new WorkspaceOffboardingService(pool,true).resolve(a,owner,member,{reason:'tenant route departure',replacementId:owner})
 const audit=(await pool.query('SELECT id FROM "'+schema+'".audit_logs WHERE action=\'workspace.member.depart\'')).rows[0]
 assert.ok(audit)
 assert.ok((await pool.query('SELECT id FROM public.audit_logs WHERE id=$1',[audit.id])).rows[0])
 assert.equal((await pool.query('SELECT participants FROM "'+schema+'".interviews WHERE id=$1',[interview])).rows[0].participants[0].userId,owner)
 console.log('PASS expired/archived membership requests and tenant-routed handoff keep mirrored audit identities')
} finally {
 await pool?.end()
 if(created)await admin.query('DROP DATABASE "'+instance.database+'" WITH (FORCE)')
 await admin.end();await instance.stop()
}
