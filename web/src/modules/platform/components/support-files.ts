import type { ServiceAttachmentUpload } from '../api/payments'
export function validateSupportFiles(files: File[]) {
  if (files.length > 3) throw new Error('每条消息最多添加 3 个附件')
  for (const file of files) {
    if (!/\.(png|jpe?g|pdf|txt)$/i.test(file.name)) throw new Error('仅支持 PNG、JPG、PDF 和 TXT 附件')
    if (!file.size || file.size > 2 * 1024 * 1024) throw new Error('附件不能为空且单个不能超过 2 MB')
  }
}
export async function encodeSupportFiles(files: File[]): Promise<ServiceAttachmentUpload[]> {
  validateSupportFiles(files)
  return Promise.all(files.map(file => new Promise<ServiceAttachmentUpload>((resolve,reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({filename:file.name,base64:String(reader.result).split(',')[1]!})
    reader.onerror = () => reject(new Error('附件读取失败，请重新选择'))
    reader.readAsDataURL(file)
  })))
}
export function saveSupportAttachment(file: {filename:string;mimeType:string;base64:string}) {
  const bytes = Uint8Array.from(atob(file.base64), c=>c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}))
  const link = document.createElement('a')
  link.href=url; link.download=file.filename; document.body.append(link); link.click(); link.remove()
  setTimeout(()=>URL.revokeObjectURL(url),1000)
}
