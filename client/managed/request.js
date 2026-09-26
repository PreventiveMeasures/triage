import { ROLES, isRole, roleAtLeast } from '../../common/managed/roles.ts'
import { VISIBILITY_PERMISSIONS } from '../../common/managed/permissions.ts'
import { DEFAULT_MANAGED_SCAN_MODEL, MANAGED_SCAN_MODELS } from '../../common/managed/scan-models.ts'

// This module belongs to the lazy managed chunk. Both its session API and its
// custom elements share this in-memory preview, without replacing global fetch
// or changing cookies, local storage, or the server's authentication state.
let preview = null
let generation = 0

export function getPreviewRole() { return preview?.user.role ?? null }

export function setPreviewRole(role) {
  if (role !== null && !isRole(role)) throw new TypeError(`Unknown managed preview role: ${role}. Expected ${ROLES.join(', ')}.`)
  generation++
  preview = role === null ? null : {
    user: {
      id: `preview:${role}`, login: role, name: role[0].toUpperCase() + role.slice(1),
      role, avatarUrl: null, lastSeenAt: Date.now(), lastActivityAt: null,
    },
    csrfToken: null,
  }
}

function previewResponse(url, options) {
  const path = new URL(url, 'http://managed-preview.invalid').pathname
  const method = (options?.method ?? 'GET').toUpperCase()
  if (method === 'POST' && path === '/api/auth/logout') return Response.json({ ok: true })
  // The preview provides UI data, not a replacement backend. In particular,
  // actions taken with its invented identity must never reach a real server.
  if (method !== 'GET') throw new Error('Changes are not saved in the managed UI preview')
  if (path === '/api/auth/session') return Response.json(preview)
  if (path === '/api/teams') return Response.json({ teams: [] })
  if (path.startsWith('/api/admin/') && !roleAtLeast(preview.user.role, 'manage')) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  if (['/api/admin/users', '/api/admin/teams', '/api/admin/repositories'].includes(path) && preview.user.role !== 'admin') {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  const data = {
    '/api/admin/users': { users: [preview.user] },
    '/api/admin/teams': { teams: [], users: [preview.user], repos: [], permissions: VISIBILITY_PERMISSIONS },
    '/api/admin/repositories': { repositories: [], total: 0, connectedCount: 0, installUrl: null, tokenMissing: false },
    '/api/admin/reports': { reports: [], repos: [], maxBytes: 10_485_760 },
    '/api/admin/bundles': { bundles: [], repos: [], maxBytes: 104_857_600 },
    '/api/admin/history': { history: [], total: 0, page: 1, limit: 100, filters: { repos: [], users: [] } },
    '/api/admin/models': { models: MANAGED_SCAN_MODELS, defaultModel: DEFAULT_MANAGED_SCAN_MODEL },
    '/api/admin/scan-results': { bundles: [], results: [] },
  }
  return Object.hasOwn(data, path) ? Response.json(data[path]) : Response.json({ error: 'not-found' }, { status: 404 })
}

// Each request is small enough for a function ingress. Capability negotiation
// keeps local servers and older deployments on their existing raw upload API.
async function uploadInParts(url, options, send) {
  const config = await send('/api/config', { credentials: 'same-origin', signal: options.signal })
  if (!config.ok) return config
  const chunkBytes = (await config.json()).managed?.uploadChunkBytes
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > 3 * 1024 * 1024) return send(url, options)
  const file = options.body, id = crypto.randomUUID()
  const kind = url.endsWith('/reports') ? 'reports' : 'bundles'
  const count = Math.ceil(file.size / chunkBytes)
  const partHeaders = new Headers(options.headers)
  partHeaders.set('content-type', 'application/octet-stream')
  for (let index = 0; index < count; index++) {
    const response = await send(`/api/admin/uploads/${kind}/${id}/${index}`, {
      ...options, headers: partHeaders, body: file.slice(index * chunkBytes, (index + 1) * chunkBytes),
    })
    if (!response.ok) return response
  }
  const headers = new Headers(options.headers)
  headers.set('x-upload-id', id)
  headers.set('x-upload-parts', String(count))
  headers.set('x-upload-size', String(file.size))
  return send(url, { ...options, headers, body: '' })
}

export async function managedFetch(url, options) {
  options?.signal?.throwIfAborted()
  if (preview) return previewResponse(url, options)
  const started = generation
  async function send(target, init) {
    if (started !== generation) throw new DOMException('Managed session changed', 'AbortError')
    const response = await fetch(target, { ...init, cache: 'no-store' })
    if (started !== generation) throw new DOMException('Managed session changed', 'AbortError')
    return response
  }
  if (options?.method === 'POST' && ['/api/admin/reports', '/api/admin/bundles'].includes(url)
    && options.body instanceof Blob && options.body.size > 3 * 1024 * 1024) {
    return uploadInParts(url, options, send)
  }
  return await send(url, options)
}
