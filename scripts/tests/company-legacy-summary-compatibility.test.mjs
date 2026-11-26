import assert from 'node:assert/strict'
import test from 'node:test'
import {legacyBaselineMatches} from '../company-data-model.mjs'
const organization='00000000-0000-4000-8000-000000000028'
const row=sha256=>({rows:'1',sha256})
function client({summary='new-summary',projectedSummary='old-summary',ai='new-ai',projectedAi='old-ai',candidate='candidate'}={}) {
 return {async query(sql,values) {
  if(sql.includes('information_schema.columns'))return {rowCount:1}
  assert.deepEqual(values,[organization])
  const projected=sql.includes('CASE WHEN')
  if(sql.includes('interview_live_sessions')) {
   if(projected)assert.ok(sql.includes("to_jsonb(t)->'summary_stale'='false'::jsonb THEN to_jsonb(t)-'summary_stale'"))
   return {rows:[row(projected ? projectedSummary : summary)]}
  }
  if(sql.includes('enterprise_ai_settings'))return {rows:[row(projected ? projectedAi : ai)]}
  return {rows:[row(candidate)]}
 }}
}
const tables=['candidates','enterprise_ai_settings','interview_live_sessions']
const expected=[{table:'candidates',...row('candidate')},{table:'enterprise_ai_settings',...row('old-ai')},{table:'interview_live_sessions',...row('old-summary')}]
test('0107 and 0112 defaults can match one immutable legacy receipt together',async()=> {
 assert.equal(await legacyBaselineMatches(client(),organization,tables,expected),true)
})
test('0112 compatibility also applies to receipts without AI settings',async()=> {
 assert.equal(await legacyBaselineMatches(client(),organization,['interview_live_sessions'],[expected[2]]),true)
})
test('stale flags, summary/body changes, and unrelated changes still fail',async()=> {
 for(const input of [{projectedSummary:'stale-true'},{projectedSummary:'changed-body'},{candidate:'changed-candidate'},{projectedAi:'changed-model'}])
  assert.equal(await legacyBaselineMatches(client(input),organization,tables,expected),false)
})
test('a post-0112 baseline keeps the full summary fingerprint',async()=> {
 assert.equal(await legacyBaselineMatches(client(),organization,['interview_live_sessions'],[{table:'interview_live_sessions',...row('new-summary')}]),true)
})
