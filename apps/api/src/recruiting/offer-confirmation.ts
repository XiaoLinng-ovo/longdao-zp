import type { OfferRecord, OfferVersionRecord } from './types.js'

interface VersionEvent {
  action: string
  createdAt: string
  reason?: string | null
  metadata?: Record<string, unknown>
}

export function lastOfferEmail(events: VersionEvent[]): { to: string; subject: string } | undefined {
  const event = [...events].filter(item => ['send', 'resend', 'resend_cancelled'].includes(item.action))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const to = event?.metadata?.recipient
  const subject = event?.metadata?.subject
  return typeof to === 'string' && typeof subject === 'string' ? { to, subject } : undefined
}

export function offerConfirmation(offer: OfferRecord, versions: OfferVersionRecord[], events: VersionEvent[]) {
  const chronological = [...versions].sort((a, b) => a.version - b.version)
  const confirmations = events.filter(event => event.action === 'accept' || event.action === 'confirm_revision').map(event => {
    const version = chronological.find(item => item.id === event.metadata?.versionId)
      ?? (event.action === 'accept' && !event.metadata?.versionId ? chronological.filter(item => item.createdAt <= event.createdAt).at(-1) : undefined)
    return version ? { versionId: version.id, version: version.version, acceptedAt: event.createdAt, reason: event.reason ?? '' } : undefined
  }).filter((item): item is NonNullable<typeof item> => Boolean(item))
  // Historical acceptance records did not include a version identifier.
  if (offer.status === 'accepted' && !events.some(event => event.action === 'accept') && !confirmations.length && offer.respondedAt) {
    const version = chronological.filter(item => item.createdAt <= offer.respondedAt!).at(-1)
    if (version) confirmations.push({ versionId: version.id, version: version.version, acceptedAt: offer.respondedAt, reason: '' })
  }
  confirmations.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.version - b.version)
  const currentConfirmed = confirmations.some(item => item.versionId === offer.currentVersionId)
  const lastSend = [...events].filter(event => ['send', 'resend', 'resend_cancelled'].includes(event.action))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  return {
    currentVersionStatus: offer.status !== 'accepted' ? 'not_accepted' as const : currentConfirmed ? 'confirmed' as const : 'pending' as const,
    confirmations,
    ...(lastSend ? { lastSentAt: lastSend.createdAt, lastSentVersionId: lastSend.metadata?.versionId as string | undefined } : {}),
  }
}
