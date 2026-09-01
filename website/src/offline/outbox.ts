import {
  db,
  type ChatDisplayPayload,
  type ChatOutboxPayload,
  type DurableOutboxRecord,
  type DurableOutboxStatus,
  type NoteDisplayPayload,
  type NoteOperation,
  type NoteOutboxPayload,
  type OutboxError,
  type ChatOutboxRecord,
  type NoteOutboxRecord,
} from './db'

export type { ChatDisplayPayload, ChatOutboxPayload, NoteDisplayPayload, NoteOperation, NoteOutboxPayload, OutboxError }
export type { ChatOutboxRecord, DurableOutboxRecord, DurableOutboxStatus, NoteOutboxRecord }

export interface ChatDisplayInput {
  content: string
  role: 'user' | 'assistant' | 'system'
  ts: number
  sendId?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface ChatEnqueueInput {
  localId?: string
  clientId?: string
  sendId?: string
  slotId?: string
  sessionId?: string
  payload: ChatOutboxPayload
  displayPayload: ChatDisplayInput
  status?: DurableOutboxStatus
  attempts?: number
  createdAt?: number
  order?: number
}

export interface NoteEnqueueInput {
  localId?: string
  clientId?: string
  slotId?: string
  sessionId?: string
  vaultId: string
  path: string
  operation: NoteOperation
  payload: NoteOutboxPayload
  displayPayload: NoteDisplayPayload
  status?: DurableOutboxStatus
  attempts?: number
  createdAt?: number
  order?: number
}

export interface OutboxListOptions {
  kind?: DurableOutboxRecord['kind']
  status?: DurableOutboxStatus | DurableOutboxStatus[]
  slotId?: string
  sessionId?: string
  vaultId?: string
  path?: string
}

export interface OutboxUpdate {
  status?: DurableOutboxStatus
  attempts?: number
  lastAttemptAt?: number
  deliveredAt?: number
  serverId?: string
  error?: OutboxError
  conflict?: unknown
  slotId?: string
  sessionId?: string
  vaultId?: string
  path?: string
  payload?: DurableOutboxRecord['payload']
  displayPayload?: DurableOutboxRecord['displayPayload']
  sendId?: string
  operation?: NoteOperation
}

export interface OutboxUpdateOptions {
  /** Refuse the update when another tab has already changed this record. */
  expectedUpdatedAt?: number
}

export type OutboxStatusCounts = {
  [Status in DurableOutboxStatus]: number
}

/** Local chat rows remain ordinary user messages. The server's `queued` role is
 * reserved for queue entries owned by the gateway and has different controls. */
export const LOCAL_CHAT_STATUSES: DurableOutboxStatus[] = [
  'pending', 'sending', 'queued', 'unknown', 'error', 'conflict',
]

export interface ChatServerMessage {
  meta?: Record<string, unknown>
}

export interface LocalChatMessage {
  role: 'user'
  content: string
  cls: string
  ts: string
  meta: Record<string, unknown>
}

/** Convert a durable row into the reload-safe message shape used by the store. */
export function localChatMessage(record: ChatOutboxRecord): LocalChatMessage {
  return {
    role: 'user',
    content: record.displayPayload.content,
    cls: 'msg msg-u',
    ts: new Date(record.displayPayload.ts).toISOString(),
    meta: {
      ...(record.displayPayload.metadata ?? {}),
      sendId: record.sendId,
      localOutbox: true,
      localOutboxId: record.localId,
      outboxStatus: record.status,
      optimistic: true,
    },
  }
}

/** Match durable sends only by the server's stable send identity. */
export function reconcileChatOutbox(
  records: ChatOutboxRecord[],
  messages: ChatServerMessage[],
): { matched: ChatOutboxRecord[]; pending: ChatOutboxRecord[] } {
  const sendIds = new Set(
    messages
      .map(message => message.meta?.sendId)
      .filter((sendId): sendId is string => typeof sendId === 'string' && sendId.length > 0),
  )
  const matched: ChatOutboxRecord[] = []
  const pending: ChatOutboxRecord[] = []
  for (const record of records) {
    if (sendIds.has(record.sendId)) matched.push(record)
    else if (LOCAL_CHAT_STATUSES.includes(record.status)) pending.push(record)
  }
  return { matched, pending }
}

export interface OutboxStatusSnapshot {
  counts: OutboxStatusCounts
  total: number
  active: number
  oldestPendingAt?: number
  lastError?: OutboxError
  updatedAt: number
}

const INITIAL_COUNTS: OutboxStatusCounts = {
  pending: 0,
  sending: 0,
  delivered: 0,
  queued: 0,
  unknown: 0,
  error: 0,
  conflict: 0,
}

const listeners = new Set<() => void>()
let cachedSnapshot: OutboxStatusSnapshot = {
  counts: { ...INITIAL_COUNTS },
  total: 0,
  active: 0,
  updatedAt: 0,
}

function notify(): void {
  for (const listener of listeners) listener()
}

async function notifyChanged(): Promise<void> {
  cachedSnapshot = await readStatusSnapshot()
  notify()
}

function clientUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function sortRecords(records: DurableOutboxRecord[]): DurableOutboxRecord[] {
  return records.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.localId.localeCompare(b.localId))
}

function matches(record: DurableOutboxRecord, options: OutboxListOptions): boolean {
  const statuses = options.status === undefined
    ? undefined
    : Array.isArray(options.status) ? options.status : [options.status]
  return (options.kind === undefined || record.kind === options.kind)
    && (statuses === undefined || statuses.includes(record.status))
    && (options.slotId === undefined || record.slotId === options.slotId)
    && (options.sessionId === undefined || record.sessionId === options.sessionId)
    && (options.vaultId === undefined || record.vaultId === options.vaultId)
    && (options.path === undefined || record.path === options.path)
}

async function nextOrder(): Promise<number> {
  const last = await db.durableOutbox.orderBy('order').last()
  return (last?.order ?? 0) + 1
}

function commonRecord(input: {
  localId?: string
  clientId?: string
  status?: DurableOutboxStatus
  attempts?: number
  createdAt?: number
  order?: number
}): { localId: string; clientId: string; status: DurableOutboxStatus; attempts: number; createdAt: number; order?: number } {
  const localId = input.localId ?? input.clientId ?? clientUuid()
  return {
    localId,
    clientId: input.clientId ?? localId,
    status: input.status ?? 'pending',
    attempts: input.attempts ?? 0,
    createdAt: input.createdAt ?? Date.now(),
    order: input.order,
  }
}

/** Add a chat turn once, retaining its wire payload and reload-safe display payload. */
export async function enqueueChat(input: ChatEnqueueInput): Promise<ChatOutboxRecord> {
  const base = commonRecord(input)
  const sendId = input.sendId ?? input.clientId ?? base.localId
  const record: ChatOutboxRecord = {
    ...base,
    kind: 'chat',
    clientId: input.clientId ?? sendId,
    sendId,
    slotId: input.slotId,
    sessionId: input.sessionId,
    payload: input.payload,
    displayPayload: {
      ...input.displayPayload,
      sendId,
    },
    order: input.order ?? 0,
    updatedAt: base.createdAt,
  }

  await db.transaction('rw', db.durableOutbox, async () => {
    if (input.order === undefined) record.order = await nextOrder()
    await db.durableOutbox.put(record)
  })
  await notifyChanged()
  return record
}

/** Add a locally authored Notes operation with enough content to render after reload. */
export async function enqueueNote(input: NoteEnqueueInput): Promise<NoteOutboxRecord> {
  const base = commonRecord(input)
  const record: NoteOutboxRecord = {
    ...base,
    kind: 'note',
    slotId: input.slotId,
    sessionId: input.sessionId,
    vaultId: input.vaultId,
    path: input.path,
    operation: input.operation,
    payload: input.payload,
    displayPayload: input.displayPayload,
    order: input.order ?? 0,
    updatedAt: base.createdAt,
  }

  await db.transaction('rw', db.durableOutbox, async () => {
    if (input.order === undefined) record.order = await nextOrder()
    await db.durableOutbox.put(record)
  })
  await notifyChanged()
  return record
}

export async function listOutbox(options: OutboxListOptions = {}): Promise<DurableOutboxRecord[]> {
  const records = await db.durableOutbox.toArray()
  return sortRecords(records.filter(record => matches(record, options)))
}

export async function getOutbox(localId: string): Promise<DurableOutboxRecord | undefined> {
  return db.durableOutbox.get(localId)
}

/** Update a durable record without allowing an older replay result to win a race. */
export async function updateOutbox(
  localId: string,
  patch: OutboxUpdate,
  options: OutboxUpdateOptions = {},
): Promise<DurableOutboxRecord | undefined> {
  let updated: DurableOutboxRecord | undefined
  await db.transaction('rw', db.durableOutbox, async () => {
    const current = await db.durableOutbox.get(localId)
    if (!current || (options.expectedUpdatedAt !== undefined && current.updatedAt !== options.expectedUpdatedAt)) return
    const now = Date.now()
    updated = {
      ...current,
      ...patch,
      localId: current.localId,
      clientId: current.clientId,
      kind: current.kind,
      updatedAt: now,
    } as DurableOutboxRecord
    if (patch.status === 'delivered' && updated.deliveredAt === undefined) updated.deliveredAt = now
    await db.durableOutbox.put(updated)
  })
  if (updated) await notifyChanged()
  return updated
}

export async function deleteOutbox(localId: string, options: OutboxUpdateOptions = {}): Promise<boolean> {
  let deleted = false
  await db.transaction('rw', db.durableOutbox, async () => {
    const current = await db.durableOutbox.get(localId)
    if (!current || (options.expectedUpdatedAt !== undefined && current.updatedAt !== options.expectedUpdatedAt)) return
    await db.durableOutbox.delete(localId)
    deleted = true
  })
  if (deleted) await notifyChanged()
  return deleted
}

/** Recover interrupted sends as delivery-unknown rather than silently duplicating a turn. */
export async function recoverSendingOutbox(status: 'unknown' | 'pending' = 'unknown'): Promise<number> {
  let recovered = 0
  await db.transaction('rw', db.durableOutbox, async () => {
    const records = await db.durableOutbox.where('status').equals('sending').toArray()
    const now = Date.now()
    for (const record of records) {
      const next: DurableOutboxRecord = {
        ...record,
        status,
        updatedAt: now,
        ...(status === 'unknown' ? {
          error: record.error ?? { code: 'DELIVERY_UNKNOWN', message: 'Delivery was interrupted before it could be confirmed.' },
        } : {}),
      }
      await db.durableOutbox.put(next)
      recovered += 1
    }
  })
  if (recovered) await notifyChanged()
  return recovered
}

export async function retryOutbox(localId: string): Promise<DurableOutboxRecord | undefined> {
  return updateOutbox(localId, { status: 'pending', error: undefined, conflict: undefined })
}

async function readStatusSnapshot(): Promise<OutboxStatusSnapshot> {
  const records = await db.durableOutbox.toArray()
  const counts: OutboxStatusCounts = { ...INITIAL_COUNTS }
  let oldestPendingAt: number | undefined
  let lastError: { error: OutboxError; updatedAt: number } | undefined

  for (const record of records) {
    counts[record.status] += 1
    if (record.status === 'pending' || record.status === 'queued') {
      oldestPendingAt = oldestPendingAt === undefined
        ? record.createdAt
        : Math.min(oldestPendingAt, record.createdAt)
    }
    if (record.error && (!lastError || record.updatedAt > lastError.updatedAt)) {
      lastError = { error: record.error, updatedAt: record.updatedAt }
    }
  }

  return {
    counts,
    total: records.length,
    active: counts.pending + counts.queued + counts.sending,
    oldestPendingAt,
    lastError: lastError?.error,
    updatedAt: Date.now(),
  }
}

export async function getOutboxStatusSnapshot(): Promise<OutboxStatusSnapshot> {
  cachedSnapshot = await readStatusSnapshot()
  return cachedSnapshot
}

export function getCachedOutboxStatusSnapshot(): OutboxStatusSnapshot {
  return cachedSnapshot
}

export function subscribeOutboxStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function listLocalNotes(options: Omit<OutboxListOptions, 'kind'> = {}): Promise<NoteOutboxRecord[]> {
  const records = await listOutbox({ ...options, kind: 'note' })
  return records.filter((record): record is NoteOutboxRecord => record.kind === 'note')
}

/** Return the newest local operation for a vault/path, useful for reload hydration. */
export async function getLocalNote(vaultId: string, path: string): Promise<NoteOutboxRecord | undefined> {
  const records = await listLocalNotes({ vaultId, path })
  return records.at(-1)
}
