import { db, type OutboxRecord } from './db'
import { fetchDirect } from './transport'

export interface SyncStatusSnapshot {
  online: boolean
  pending: number
  syncing: boolean
  conflicts: number
}

const MAX_ATTEMPTS = 3
const listeners = new Set<() => void>()

let started = false
let flushPromise: Promise<void> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let snapshot: SyncStatusSnapshot = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pending: 0,
  syncing: false,
  conflicts: 0,
}

function notify(): void {
  for (const listener of listeners) listener()
}

async function refreshSnapshot(): Promise<void> {
  const [outbox, tasks] = await Promise.all([db.outbox.toArray(), db.tasks.toArray()])
  snapshot = {
    ...snapshot,
    pending: outbox.filter(item => item.status === 'pending' || item.status === 'sending').length,
    conflicts: tasks.filter(task => task.syncState === 'conflict').length,
  }
  notify()
}

function scheduleRetry(delayMs = 1000): void {
  if (!snapshot.online || retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flushOutbox()
  }, Math.min(delayMs, 30_000))
}

function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError || error instanceof DOMException || error instanceof Error
}

async function responseData(response: Response): Promise<unknown> {
  try {
    return await response.clone().json()
  } catch {
    return undefined
  }
}

function serverId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  for (const key of ['id', 'task_id', 'taskId']) {
    if (typeof record[key] === 'string' || typeof record[key] === 'number') return String(record[key])
  }
  return undefined
}

async function updateLocalTask(
  clientId: string,
  syncState: 'synced' | 'error' | 'conflict',
  data?: unknown,
): Promise<void> {
  const task = await db.tasks.where('clientId').equals(clientId).first()
  if (!task) return
  const nextId = syncState === 'synced' ? (serverId(data) ?? task.id) : task.id
  const next = {
    ...task,
    id: nextId,
    data: data ?? task.data,
    syncState,
    updatedAt: Date.now(),
  }
  if (next.id !== task.id) await db.tasks.delete(task.id)
  await db.tasks.put(next)
}

async function markSendingTask(clientId: string): Promise<void> {
  const task = await db.tasks.where('clientId').equals(clientId).first()
  if (task) await db.tasks.put({ ...task, syncState: 'syncing', updatedAt: Date.now() })
}

async function processItem(item: OutboxRecord): Promise<'continue' | 'stop'> {
  if (item.id === undefined) return 'continue'

  await db.outbox.update(item.id, { status: 'sending' })
  await markSendingTask(item.clientId)

  try {
    const headers = new Headers(item.headers)
    headers.set('Accept', 'application/json')
    headers.set('X-Idempotency-Key', item.clientId)
    let body: BodyInit | undefined
    if (item.method !== 'DELETE' && item.payload !== undefined) {
      body = typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload)
      headers.set('Content-Type', 'application/json')
    }

    const response = await fetchDirect(item.url, {
      method: item.method,
      headers,
      credentials: item.credentials ?? 'same-origin',
      body,
    })

    if (response.ok) {
      const data = await responseData(response)
      await db.outbox.delete(item.id)
      await updateLocalTask(item.clientId, 'synced', data)
      return 'continue'
    }

    if (response.status === 409 || response.status === 404) {
      await db.outbox.delete(item.id)
      await updateLocalTask(item.clientId, response.status === 409 ? 'conflict' : 'error')
      return 'continue'
    }

    const attempts = item.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      await db.outbox.update(item.id, { status: 'failed', attempts })
      await updateLocalTask(item.clientId, 'error')
      return 'continue'
    }
    await db.outbox.update(item.id, { status: 'pending', attempts })
    return 'continue'
  } catch (error) {
    const attempts = item.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      await db.outbox.update(item.id, { status: 'failed', attempts })
      await updateLocalTask(item.clientId, 'error')
    } else {
      await db.outbox.update(item.id, { status: 'pending', attempts })
    }
    if (isNetworkFailure(error)) {
      snapshot = { ...snapshot, online: false }
      notify()
      return 'stop'
    }
    return 'continue'
  }
}

export async function flushOutbox(): Promise<void> {
  if (!snapshot.online || flushPromise) return flushPromise ?? Promise.resolve()

  flushPromise = (async () => {
    snapshot = { ...snapshot, syncing: true }
    notify()
    try {
      const items = (await db.outbox.toArray())
        .filter(item => item.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt)
      for (const item of items) {
        if (!snapshot.online) break
        const result = await processItem(item)
        await refreshSnapshot()
        if (result === 'stop') break
      }
    } finally {
      snapshot = { ...snapshot, syncing: false }
      await refreshSnapshot()
      notify()
      flushPromise = null
      if (snapshot.pending > 0 && snapshot.online) {
        const pending = await db.outbox.where('status').equals('pending').toArray()
        const attempts = pending.reduce((max, item) => Math.max(max, item.attempts), 0)
        scheduleRetry(1000 * 2 ** attempts)
      }
    }
  })()

  return flushPromise
}

export function triggerSync(): void {
  void flushOutbox()
}

export function getSyncStatus(): SyncStatusSnapshot {
  return snapshot
}

export function subscribeSyncStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function startSyncEngine(): void {
  if (started || typeof window === 'undefined') return
  started = true

  const setOnline = () => {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    snapshot = { ...snapshot, online: true }
    notify()
    void refreshSnapshot().then(() => flushOutbox())
  }
  const setOffline = () => {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    snapshot = { ...snapshot, online: false, syncing: false }
    notify()
  }

  window.addEventListener('online', setOnline)
  window.addEventListener('offline', setOffline)
  void db.outbox.where('status').equals('sending').modify({ status: 'pending' })
    .then(() => refreshSnapshot())
    .then(() => flushOutbox())
}
