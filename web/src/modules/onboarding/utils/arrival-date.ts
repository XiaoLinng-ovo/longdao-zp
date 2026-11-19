import { formatBusinessDateTime } from '../../../shared/utils/date-time'

export function actualArrivalDate(value?: string): string {
  return formatBusinessDateTime(value, '').slice(0, 10)
}
