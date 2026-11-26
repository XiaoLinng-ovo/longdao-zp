import { apiClient } from '../../../shared/api'
export interface TodoNotification {
  id: string; taskKey: string; kind: string; title: string; description: string
  path: string | null; state: 'active' | 'resolved' | 'cancelled'; readAt: string | null; createdAt: string
}
export interface NotificationInbox { items: TodoNotification[]; unreadCount: number; nextBefore: string | null }
export async function loadNotifications(unread = false, before?: string): Promise<NotificationInbox> {
  const params = new URLSearchParams({ unread: unread ? '1' : '0' })
  if (before) params.set('before', before)
  return (await apiClient.getJson<NotificationInbox>('/dashboard/notifications?' + params)).data
}
export async function readNotifications(ids: string[] | 'all'): Promise<void> {
  await apiClient.postJson('/dashboard/notifications/read', ids === 'all' ? { all: true } : { ids })
}
