import { db, type OutboxRecord } from './db'
import { captureNativeFetch } from './transport'
import { triggerSync } from './syncEngine'

const MUTATION_METHODS = new Set<OutboxRecord['method']>(['POST', 'PUT', 'DELETE', 'PATCH'])
let installed = false

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    const raw = input instanceof Request ? input.url : input.toString()
    return new URL(raw, window.location.href)
  } catch {
    return null
  }
}

function shouldIntercept(url: URL, request: Request): boolean {
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return false
  if (url.pathname === '/api/ws' || url.pathname === '/api/chat' || url.pathname === '/api/logs') return false
  if (request.headers.get('Accept')?.includes('text/event-stream')) return false
  return true
}

function responseFromData(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function cacheJsonResponse(url: string, response: Response): Promise<void> {
  if (!response.ok) return
  const contentType = response.headers.get('Content-Type') ?? ''
  if (contentType && !contentType.includes('json')) return
  try {
    const data = await response.clone().json()
    await db.sessions.put({ id: url, data, updatedAt: Date.now() })
  } catch {
    // A malformed response should still be returned to the caller; it simply
    // cannot become a useful offline cache entry.
  }
}

async function readPayload(request: Request): Promise<unknown> {
  if (!request.body) return undefined
  const text = await request.clone().text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function clientUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function localResponseData(payload: unknown, clientId: string, method: OutboxRecord['method']): unknown {
  if (method === 'DELETE') return { ok: true, clientId }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), id: (payload as Record<string, unknown>).id ?? clientId, clientId }
  }
  return { data: payload, id: clientId, clientId }
}

function canQueueMutation(request: Request): boolean {
  const contentType = request.headers.get('Content-Type')?.toLowerCase() ?? ''
  return !contentType || contentType.includes('application/json') || contentType.includes('+json')
}

async function queueMutation(
  request: Request,
  url: string,
  method: OutboxRecord['method'],
): Promise<Response> {
  const clientId = clientUuid()
  const payload = await readPayload(request)
  const data = localResponseData(payload, clientId, method)
  const updatedAt = Date.now()
  const isTask = /\/(?:task|tasks|taskrunner)(?:\/|$)/i.test(new URL(url).pathname)

  await db.transaction('rw', db.tasks, db.outbox, async () => {
    if (isTask) {
      const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : undefined
      const sessionId = typeof payloadRecord?.sessionId === 'string'
        ? payloadRecord.sessionId
        : typeof payloadRecord?.session_id === 'string' ? payloadRecord.session_id : ''
      await db.tasks.put({
        id: clientId,
        clientId,
        sessionId,
        data,
        syncState: 'dirty',
        updatedAt,
      })
    }
    await db.outbox.add({
      clientId,
      method,
      url,
      payload,
      status: 'pending',
      attempts: 0,
      createdAt: updatedAt,
      headers: Object.fromEntries(request.headers.entries()),
      credentials: request.credentials,
    })
  })

  triggerSync()
  return responseFromData(data, method === 'POST' ? 201 : 200)
}

async function intercept(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> {
  const nativeFetch = captureNativeFetch()
  const request = new Request(input, init)
  const url = requestUrl(request)
  if (!url || !shouldIntercept(url, request)) return nativeFetch(request)

  const method = request.method.toUpperCase()
  if (method === 'GET') {
    if (navigator.onLine !== false) {
      try {
        const response = await nativeFetch(request)
        await cacheJsonResponse(url.href, response)
        return response
      } catch {
        const cached = await db.sessions.get(url.href)
        return cached ? responseFromData(cached.data) : new Response('Offline', { status: 503 })
      }
    }
    const cached = await db.sessions.get(url.href)
    return cached ? responseFromData(cached.data) : new Response('Offline', { status: 503 })
  }

  if (MUTATION_METHODS.has(method as OutboxRecord['method']) && canQueueMutation(request)) {
    return queueMutation(request, url.href, method as OutboxRecord['method'])
  }

  return nativeFetch(request)
}

export function installFetchInterceptor(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  captureNativeFetch()
  window.fetch = intercept as typeof window.fetch
}
