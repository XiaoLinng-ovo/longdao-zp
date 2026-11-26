import type { PoolClient } from 'pg'
import { HttpError } from '../http.js'
import { serviceMessage, serviceRequestView } from './continuity.js'

export const SUPPORT_FILE_LIMIT = 2 * 1024 * 1024
export function supportInput(input: Record<string, any>) {
  const message = serviceMessage(input.message)
  const files = input.attachments ?? []
  if (!Array.isArray(files) || files.length > 3) throw new HttpError(400, 'VALIDATION_ERROR', '每条消息最多添加 3 个附件')
  const attachments = files.map((file: any) => {
    if (!file || typeof file.filename !== 'string' || file.filename.length > 180 || !file.filename.trim()
      || /[\\/\x00-\x1f\x7f]/u.test(file.filename) || typeof file.base64 !== 'string')
      throw new HttpError(400, 'VALIDATION_ERROR', '附件名称或内容无效')
    if (file.base64.length > Math.ceil(SUPPORT_FILE_LIMIT / 3) * 4) throw new HttpError(413, 'ATTACHMENT_TOO_LARGE', '单个附件不能超过 2 MB')
    if (file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64))
      throw new HttpError(400, 'VALIDATION_ERROR', '附件编码无效')
    const content = Buffer.from(file.base64, 'base64')
    if (content.toString('base64') !== file.base64) throw new HttpError(400, 'VALIDATION_ERROR', '附件编码无效')
    if (!content.length || content.length > SUPPORT_FILE_LIMIT) throw new HttpError(413, 'ATTACHMENT_TOO_LARGE', '附件不能为空且不能超过 2 MB')
    const ext = file.filename.split('.').pop()?.toLowerCase()
    const mime = ext === 'png' && content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
      : ['jpg','jpeg'].includes(ext) && content.subarray(0,3).equals(Buffer.from('ffd8ff','hex')) ? 'image/jpeg'
      : ext === 'pdf' && content.subarray(0,5).toString() === '%PDF-' ? 'application/pdf'
      : ext === 'txt' && !content.includes(0) && Buffer.from(content.toString('utf8')).equals(content) ? 'text/plain' : null
    if (!mime) throw new HttpError(400, 'ATTACHMENT_TYPE_INVALID', '仅支持内容与扩展名一致的 PNG、JPG、PDF、UTF-8 TXT 附件')
    return { filename: file.filename.trim(), mime, content }
  })
  return { message, attachments }
}
export async function insertSupportMessage(db: PoolClient, requestId: string, actor: string, kind: 'member' | 'administrator', input: ReturnType<typeof supportInput>) {
  const used = (await db.query(
    'SELECT COALESCE(sum(a.size_bytes),0)::bigint AS bytes FROM public.enterprise_service_attachments a JOIN public.enterprise_service_messages m ON m.id=a.message_id WHERE m.request_id=$1', [requestId])).rows[0]
  if (Number(used.bytes) + input.attachments.reduce((n,a) => n+a.content.length,0) > 30 * 1024 * 1024)
    throw new HttpError(413, 'TICKET_ATTACHMENT_LIMIT', '该工单附件总量已达到 30 MB 上限，请改用文字说明')
  const row = (await db.query('INSERT INTO public.enterprise_service_messages(request_id,author_id,author_kind,message) VALUES($1,$2,$3,$4) RETURNING id', [requestId,actor,kind,input.message])).rows[0]
  for (const a of input.attachments) await db.query('INSERT INTO public.enterprise_service_attachments(message_id,filename,mime_type,content,size_bytes) VALUES($1,$2,$3,$4,$5)', [row.id,a.filename,a.mime,a.content,a.content.length])
  return row.id as string
}
export async function readSupportThread(db: PoolClient, request: Record<string, any>, before?: string) {
  if (before && !(await db.query('SELECT id FROM public.enterprise_service_messages WHERE id=$1 AND request_id=$2',[before,request.id])).rowCount)
    throw new HttpError(400, 'VALIDATION_ERROR', '消息分页位置无效')
  const rows = (await db.query(
    `SELECT m.id,m.author_kind,m.message,m.created_at FROM public.enterprise_service_messages m
      WHERE m.request_id=$1 AND ($2::uuid IS NULL OR (m.created_at,m.id)<(SELECT created_at,id FROM public.enterprise_service_messages WHERE id=$2))
      ORDER BY m.created_at DESC,m.id DESC LIMIT 51`, [request.id,before ?? null])).rows
  const hasMore = rows.length > 50
  const page = rows.slice(0,50).reverse()
  const attachments = page.length ? (await db.query('SELECT id,message_id,filename,mime_type,size_bytes FROM public.enterprise_service_attachments WHERE message_id=ANY($1::uuid[]) ORDER BY id',[page.map(m=>m.id)])).rows : []
  return { request: serviceRequestView(request), hasMore, nextBefore: hasMore ? page[0]?.id : null,
    messages: page.map(m=>({id:m.id,authorKind:m.author_kind,message:m.message,createdAt:m.created_at,
      attachments:attachments.filter(a=>a.message_id===m.id).map(a=>({id:a.id,filename:a.filename,mimeType:a.mime_type,sizeBytes:a.size_bytes}))})) }
}
