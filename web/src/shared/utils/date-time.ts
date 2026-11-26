/** Date-only values are business dates; timestamps use the business timezone. */
export function formatBusinessDateTime(value?: string, empty = '未记录'): string {
  if (!value) return empty
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return empty
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value
  return part('year') + '-' + part('month') + '-' + part('day') + ' ' + part('hour') + ':' + part('minute') + ':' + part('second')
}
