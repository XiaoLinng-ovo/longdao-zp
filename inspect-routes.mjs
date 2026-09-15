import fs from 'node:fs'
const c=fs.readFileSync('apps/api/src/routes.ts','utf8')
for (const needle of ["if (path === '/api/v1/recruitment-requests' && method === 'POST')", "if (path === '/api/v1/jobs' && method === 'POST')", "if (!suffix && method === 'PATCH')"]) {
  const idx=c.indexOf(needle)
  console.log('---', needle, idx)
  if(idx>=0) console.log(JSON.stringify(c.slice(Math.max(0,idx-30), idx+120)))
}
