import { describe, expect, it } from 'vitest'
import { localChatMessage, reconcileChatOutbox, type ChatOutboxRecord } from '../offline/outbox'
import reducer, { hydrateLocalChatOutbox } from '../store/chatSlice'

function record(overrides: Partial<ChatOutboxRecord> = {}): ChatOutboxRecord {
  return {
    kind: 'chat',
    localId: 's-1',
    clientId: 's-1',
    sendId: 's-1',
    slotId: 'slot-1',
    status: 'unknown',
    order: 1,
    attempts: 1,
    createdAt: 1000,
    updatedAt: 1000,
    payload: { message: 'wire text', slot: 'slot-1', meta: { sendId: 's-1' } },
    displayPayload: { content: 'display text', role: 'user', ts: 1000, sendId: 's-1' },
    ...overrides,
  }
}

describe('durable chat outbox reconciliation', () => {
  it('matches server rows by sendId and leaves unmatched records replayable', () => {
    const matched = record()
    const pending = record({ localId: 's-2', clientId: 's-2', sendId: 's-2', order: 2 })
    const result = reconcileChatOutbox(
      [matched, pending],
      [{ meta: { sendId: 's-1', mid: 'm-1' } }],
    )
    expect(result.matched.map(item => item.sendId)).toEqual(['s-1'])
    expect(result.pending.map(item => item.sendId)).toEqual(['s-2'])
  })

  it('hydrates a local row as a normal user message, never a server queued role', () => {
    const message = localChatMessage(record())
    expect(message).toMatchObject({
      role: 'user',
      content: 'display text',
      meta: { sendId: 's-1', localOutbox: true, outboxStatus: 'unknown', optimistic: true },
    })
    expect(message.role).not.toBe('queued')

    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, hydrateLocalChatOutbox({ slot: 'slot-1', messages: [message] }))
    expect(state.messages).toHaveLength(0)
    expect(state.slotMessages['slot-1']).toHaveLength(1)
    expect(state.slotMessages['slot-1'][0].role).toBe('user')
  })

  it('does not add a second local row when reload hydration runs twice', () => {
    const message = localChatMessage(record())
    let state = reducer(undefined, { type: '@@INIT' })
    state = reducer(state, hydrateLocalChatOutbox({ slot: 'slot-1', messages: [message] }))
    state = reducer(state, hydrateLocalChatOutbox({ slot: 'slot-1', messages: [message] }))
    expect(state.slotMessages['slot-1']).toHaveLength(1)
  })
})
