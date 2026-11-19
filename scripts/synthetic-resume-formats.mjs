import { createRequire } from 'node:module'
import { join } from 'node:path'
import { projectRoot } from './isolated-environment.mjs'
import { syntheticResumeEvidence } from './local-model-boundary.mjs'

export const syntheticResumeText = '姓名：合成同名人员\n邮箱：candidate@example.invalid\n学历：本科\n' + syntheticResumeEvidence

export function syntheticPdf({ scanned = false, mixed = false } = {}) {
  const lines = syntheticResumeText.split('\n')
  const stream = scanned ? 'q 500 0 0 700 20 20 cm /Im0 Do Q' : lines.map((line, index) =>
    `BT /F1 12 Tf 30 ${740 - index * 30} Td <${Buffer.from(line, 'utf16le').swap16().toString('hex')}> Tj ET`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R${mixed ? ' 7 0 R' : ''}] /Count ${mixed ? 2 : 1} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /Im0 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor << /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /Ascent 900 /Descent -200 /CapHeight 700 /ItalicAngle 0 /StemV 80 >> >>] >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nx\nendstream',
  ]
  if (mixed) {
    const imageStream = 'q 500 0 0 700 20 20 cm /Im0 Do Q'
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 6 0 R >> >> /Contents 8 0 R >>',
      `<< /Length ${imageStream.length} >>\nstream\n${imageStream}\nendstream`)
  }
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)
}

export async function syntheticDocx() {
  const require = createRequire(join(projectRoot, 'apps/api/package.json'))
  const JSZip = createRequire(require.resolve('mammoth'))('jszip')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + syntheticResumeText.split('\n').map(line => '<w:p><w:r><w:t>' + escape(line) + '</w:t></w:r></w:p>').join('') + '</w:body></w:document>')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
