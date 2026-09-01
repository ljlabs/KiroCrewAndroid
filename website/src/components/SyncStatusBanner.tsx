import { useSyncExternalStore } from 'react'
import { getSyncStatus, subscribeSyncStatus } from '../offline/syncEngine'
import { getCachedOutboxStatusSnapshot, subscribeOutboxStatus } from '../offline/outbox'

export default function SyncStatusBanner() {
  const status = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus)
  const durable = useSyncExternalStore(
    subscribeOutboxStatus,
    getCachedOutboxStatusSnapshot,
    getCachedOutboxStatusSnapshot,
  )
  const pending = status.pending + durable.active
  const conflicts = status.conflicts + durable.counts.conflict
  const errors = durable.counts.error

  if (conflicts > 0) {
    return (
      <div className="fixed top-safe-offset-[50px] left-1/2 z-[70] -translate-x-1/2 rounded-md border border-red-400/40 bg-red-500/90 px-3 py-1.5 text-[12px] font-medium text-white shadow-lg" role="status" aria-live="polite">
        {conflicts} {conflicts === 1 ? 'item has' : 'items have'} sync conflicts. Review needed.
      </div>
    )
  }

  if (errors > 0) {
    return (
      <div className="fixed top-safe-offset-[50px] left-1/2 z-[70] -translate-x-1/2 rounded-md border border-red-400/40 bg-red-500/90 px-3 py-1.5 text-[12px] font-medium text-white shadow-lg" role="status" aria-live="polite">
        {errors} {errors === 1 ? 'change' : 'changes'} need attention. Retry from the message.
      </div>
    )
  }

  if (!status.online) {
    return (
      <div className="fixed top-safe-offset-[50px] left-1/2 z-[70] -translate-x-1/2 rounded-md border border-yellow-400/40 bg-yellow-500/90 px-3 py-1.5 text-[12px] font-medium text-black shadow-lg" role="status" aria-live="polite">
        Offline. Drafts and messages will sync when the gateway returns.
      </div>
    )
  }

  if (pending > 0) {
    return (
      <div className="fixed top-safe-offset-[50px] left-1/2 z-[70] -translate-x-1/2 rounded-md border border-blue-400/40 bg-blue-500/90 px-3 py-1.5 text-[12px] font-medium text-white shadow-lg" role="status" aria-live="polite">
        Syncing {pending} {pending === 1 ? 'change' : 'changes'}...
      </div>
    )
  }

  return null
}
