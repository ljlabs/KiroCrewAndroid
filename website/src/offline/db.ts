import Dexie, { type Table } from 'dexie'

export interface SessionRecord {
  id: string
  data: unknown
  updatedAt: number
}

export interface TaskRecord {
  id: string
  clientId: string
  sessionId: string
  data: unknown
  syncState: 'synced' | 'dirty' | 'syncing' | 'error' | 'conflict'
  updatedAt: number
}

export interface OutboxRecord {
  id?: number
  clientId: string
  method: 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  url: string
  payload: unknown
  status: 'pending' | 'sending' | 'failed'
  attempts: number
  createdAt: number
  headers?: Record<string, string>
  credentials?: RequestCredentials
}

/** Durable records owned by the offline-first chat and Notes adapters. */
export type DurableOutboxKind = 'chat' | 'note'

export type DurableOutboxStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'queued'
  | 'unknown'
  | 'error'
  | 'conflict'

export interface OutboxError {
  code?: string
  message: string
  details?: unknown
}

export interface ChatOutboxPayload {
  message: string
  slot?: string
  color_theme?: string
  theme_consent_sha?: string
  meta?: unknown
  steer?: unknown
  [key: string]: unknown
}

export interface ChatDisplayPayload {
  content: string
  role: 'user' | 'assistant' | 'system'
  ts: number
  sendId: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export type NoteOperation = 'create' | 'save' | 'move' | 'delete'

export interface NoteOutboxPayload {
  operation: NoteOperation
  vaultId: string
  path: string
  content?: string
  title?: string
  baseMtime?: string | number
  toPath?: string
  [key: string]: unknown
}

export interface NoteDisplayPayload {
  vaultId: string
  path: string
  title?: string
  content?: string
  mtime?: string | number
  [key: string]: unknown
}

interface DurableOutboxBase {
  localId: string
  clientId: string
  status: DurableOutboxStatus
  order: number
  attempts: number
  createdAt: number
  updatedAt: number
  lastAttemptAt?: number
  deliveredAt?: number
  serverId?: string
  error?: OutboxError
  conflict?: unknown
  slotId?: string
  sessionId?: string
  vaultId?: string
  path?: string
}

export interface ChatOutboxRecord extends DurableOutboxBase {
  kind: 'chat'
  sendId: string
  payload: ChatOutboxPayload
  displayPayload: ChatDisplayPayload
}

export interface NoteOutboxRecord extends DurableOutboxBase {
  kind: 'note'
  operation: NoteOperation
  payload: NoteOutboxPayload
  displayPayload: NoteDisplayPayload
}

export type DurableOutboxRecord = ChatOutboxRecord | NoteOutboxRecord

export class OfflineDB extends Dexie {
  sessions!: Table<SessionRecord, string>
  tasks!: Table<TaskRecord, string>
  /** Legacy generic REST mutation queue; do not mix with durableOutbox. */
  outbox!: Table<OutboxRecord, number>
  /** Discriminated chat/Notes queue with stable string IDs. */
  durableOutbox!: Table<DurableOutboxRecord, string>

  constructor() {
    super('KiroCrewOfflineDB')
    this.version(1).stores({
      sessions: 'id, updatedAt',
      tasks: 'id, clientId, sessionId, syncState, updatedAt',
      outbox: '++id, clientId, status, createdAt',
    })
    // Keep the v1 tables and their numeric outbox keys unchanged. The new
    // discriminated table is additive so existing generic REST mutations and
    // their sync engine continue to work during and after the upgrade.
    this.version(2).stores({
      sessions: 'id, updatedAt',
      tasks: 'id, clientId, sessionId, syncState, updatedAt',
      outbox: '++id, clientId, status, createdAt',
      durableOutbox: 'localId, clientId, kind, status, order, createdAt, updatedAt, serverId, slotId, sessionId, vaultId, path, [kind+status], [kind+slotId], [kind+sessionId], [kind+vaultId], [kind+vaultId+path]',
    })
  }
}

export const db = new OfflineDB()
