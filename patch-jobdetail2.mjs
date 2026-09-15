import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('fs');
const p = 'web/src/modules/jobs/pages/JobDetailPage.vue';
let s = fs.readFileSync(p, 'utf8');
const startMark = 'function requirementText(item: JobRequirement): string {';
const endMark = 'function applyDocQuery() {';
const start = s.indexOf(startMark);
let end = s.indexOf(endMark);
if (start === -1 || end === -1) throw new Error('markers not found');
const replacement = `function requirementText(item: JobRequirement): string {
  const parts = [item.label, item.description].filter(Boolean)
  return parts.join('：')
}

function openSpecForm() {
  resetSpecForm()
  showSpec.value = true
}

function openJdForm() {
  showJd.value = true
}

`;
s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(p, s, 'utf8');
console.log('replaced region between requirementText and applyDocQuery');
