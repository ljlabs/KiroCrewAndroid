import { useSyncExternalStore } from 'react'
import { getSyncStatus, subscribeSyncStatus } from '../offline/syncEngine'

export default function SyncStatusBanner() {
  const status = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus)

  if (status.conflicts > 0) {
    return (
      <div className="fixed top-safe-offset-[50px] left-1/2 z-[70] -translate-x-1/2 rounded-md border border-red-400/40 bg-red-500/90 px-3 py-1.5 text-[12px] font-medium text-white shadow-lg" role="status" aria-live="polite">
        {status.conflicts} items have sync conflicts. Review needed.
      </div>
    )
  }

  if (!status.online) {
    return (
      <div className="fixed top-safe-offset-[50px] left-1/2 z-[70] -translate-x-1/2 rounded-md border border-yellow-400/40 bg-yellow-500/90 px-3 py-1.5 text-[12px] font-medium text-black shadow-lg" role="status" aria-live="polite">
        Offline. Showing cached data.
      </div>
    )
  }

  if (status.pending > 0) {
    return (
      <div className="fixed top-safe-offset-[50px] left-1/2 z-[70] -translate-x-1/2 rounded-md border border-blue-400/40 bg-blue-500/90 px-3 py-1.5 text-[12px] font-medium text-white shadow-lg" role="status" aria-live="polite">
        Syncing {status.pending} {status.pending === 1 ? 'change' : 'changes'}...
      </div>
    )
  }

  return null
}
