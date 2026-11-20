import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root=resolve(import.meta.dirname,'..')
const git=(args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024})
const tracked=git(['ls-files','-z']).split('\0').filter(Boolean)
const current=[...new Set([...tracked,...git(['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean)])]
const excluded=/\.(?:png|jpe?g|gif|ico|woff2?|ttf|pdf|docx?|xlsx?|zip|m4a|mp3|wav|mp4|exe|dll|bin|dump|lock)$/i
const rules=[
  ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['provider-secret',/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,})\b/g],
  ['credential-url',/\b(?:postgres(?:ql)?|mysql|redis|smtps?):\/\/[^\s:/]+:[^\s@/]{8,}@/g],
]
const findings=[],skipped=[],counts={current:0,artifacts:0,history:0}
function scan(text,file,scope) {
  for(const [rule,pattern] of rules) {
    pattern.lastIndex=0
    for(const match of text.matchAll(pattern)) {
      const line=text.slice(0,match.index).split('\n').length
      // Only metadata is emitted; source values never enter the report.
      findings.push({scope,file,line,rule,requiresManualReview:true})
    }
  }
}
async function scanFile(file,scope) {
  if(excluded.test(file))return
  try {
    const metadata=await stat(join(root,file))
    if(!metadata.isFile())return
    if(metadata.size>8*1024*1024){skipped.push({file,reason:'size-limit'});return}
    const bytes=await readFile(join(root,file))
    if(bytes.includes(0))return
    counts[scope]++;scan(bytes.toString('utf8'),file,scope)
  } catch(error) {skipped.push({file,reason:error.code || 'read-error'})}
}
for(const file of current)await scanFile(file,'current')
async function artifacts(directory,depth=0) {
  if(depth>8)return
  let entries
  try {entries=await readdir(join(root,directory),{withFileTypes:true})}catch{return}
  for(const entry of entries) {
    const file=join(directory,entry.name)
    if(entry.isSymbolicLink())continue
    if(entry.isDirectory()) {if(!['node_modules','.git','data','backup','storage','objects'].includes(entry.name))await artifacts(file,depth+1)}
    else await scanFile(file,'artifacts')
  }
}
for(const directory of ['logs','web/dist','tmp'])await artifacts(directory)
// Inspect every historical patch for signatures, without printing patch contents.
const commits=git(['rev-list','--all']).trim().split('\n').filter(Boolean)
for(const commit of commits) {
  const patch=git(['show','--format=','--no-ext-diff','--no-textconv','--no-renames','--unified=0',commit])
  let file='unknown'
  for(const line of patch.split('\n')) {
    if(line.startsWith('+++ b/'))file=line.slice(6)
    else if(line.startsWith('+') && !line.startsWith('+++'))scan(line.slice(1),commit+':'+file,'history')
  }
  counts.history++
}
const trackedSensitive=tracked.filter(file=>/(?:^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|[^/]+\.(?:pem|key|p12|pfx|dump))$/i.test(file))
const sensitiveName=file=>/(?:^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|[^/]+\.(?:pem|key|p12|pfx|dump))$/i.test(file)
const historicalSensitive=[...git(['log','--all','--full-history','-m','--format=','--name-only']).split('\n').map(file=>file.trim()),...findings.filter(row=>row.scope==='history').map(row=>row.file.slice(41))].filter(sensitiveName)
const installScripts=[]
for(const file of current.filter(file=>/(?:^|\/)package.json$/.test(file))) {
  try {const json=JSON.parse(await readFile(join(root,file),'utf8'));for(const name of ['preinstall','install','postinstall','prepare'])if(json.scripts?.[name])installScripts.push({file,name})}catch{}
}
const report={createdAt:new Date().toISOString(),scope:'当前文本、构建与日志、全部可达历史补丁；仅签名扫描，不代表完整秘密或个人信息检测',counts,trackedSensitive,historicalSensitive:[...new Set(historicalSensitive)],installScripts,findings,skipped,unknownFilesDeleted:0}
await mkdir(join(root,'tmp'),{recursive:true})
const output=join(root,'tmp','optimization-20261113-hygiene.json')
await writeFile(output,JSON.stringify(report,null,2))
console.log(JSON.stringify({counts,findings:findings.length,trackedSensitive:trackedSensitive.length,historicalSensitive:report.historicalSensitive.length,reportPath:output},null,2))
