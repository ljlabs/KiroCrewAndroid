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

export class OfflineDB extends Dexie {
  sessions!: Table<SessionRecord, string>
  tasks!: Table<TaskRecord, string>
  outbox!: Table<OutboxRecord, number>

  constructor() {
    super('KiroCrewOfflineDB')
    this.version(1).stores({
      sessions: 'id, updatedAt',
      tasks: 'id, clientId, sessionId, syncState, updatedAt',
      outbox: '++id, clientId, status, createdAt',
    })
  }
}

export const db = new OfflineDB()
