import assert from 'node:assert/strict'
import test from 'node:test'
import { supportInput, SUPPORT_FILE_LIMIT } from './support.js'
const file = (filename: string, content: Buffer | string) => ({filename,base64:Buffer.from(content).toString('base64')})
test('support uploads validate names, canonical base64, file signatures and per-message limits', () => {
  for (const attachment of [file('日志.txt','真实日志'),file('截图.png',Buffer.from('89504e470d0a1a0a','hex')),file('图片.jpg',Buffer.from('ffd8ff00','hex')),file('报告.pdf','%PDF-1.7')])
    assert.equal(supportInput({message:'问题说明',attachments:[attachment]}).attachments.length,1)
  for (const attachment of [file('../日志.txt','bad'),file('脚本.html','<script>'),file('fake.png','text'),file('bad.txt',Buffer.from([255])),{filename:'bad.txt',base64:'a==='},{filename:'bad.txt',base64:'Zh=='}])
    assert.throws(()=>supportInput({message:'问题说明',attachments:[attachment]}),{status:400})
  assert.throws(()=>supportInput({message:'问题说明',attachments:Array(4).fill(file('a.txt','ok'))}),{status:400})
  assert.throws(()=>supportInput({message:'问题说明',attachments:[file('a.txt','')]}),{status:413})
  assert.throws(()=>supportInput({message:'问题说明',attachments:[file('a.txt',Buffer.alloc(SUPPORT_FILE_LIMIT+1,65))]}),{status:413})
  assert.equal(supportInput({message:'问题说明',attachments:[file('a.txt',Buffer.alloc(SUPPORT_FILE_LIMIT,65))]}).attachments[0]?.content.length,SUPPORT_FILE_LIMIT)
})
