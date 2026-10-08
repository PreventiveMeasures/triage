import { ROLES, isRole, roleAtLeast } from '../../common/managed/roles.ts'
import { VISIBILITY_PERMISSIONS } from '../../common/managed/permissions.ts'
import { DEFAULT_MANAGED_SCAN_MODEL, MANAGED_SCAN_MODELS } from '../../common/managed/scan-models.ts'
import { getPublicShare } from './public-share.js'
import { UPLOAD_SEAL_HEADER, sealUpload } from '../../common/managed/upload-seal.ts'

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
  if (['/api/admin/users', '/api/admin/teams', '/api/admin/repositories', '/api/admin/repositories/aliases'].includes(path) && preview.user.role !== 'admin') {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  const data = {
    '/api/admin/users': { users: [preview.user] },
    '/api/admin/teams': { teams: [], users: [preview.user], repos: [], permissions: VISIBILITY_PERMISSIONS },
    '/api/admin/links': { shares: [] },
    '/api/admin/repositories': { repositories: [], total: 0, connectedCount: 0, installUrl: null, tokenMissing: false },
    '/api/admin/repositories/aliases': { aliases: [], repos: [] },
    '/api/admin/repositories/resolve': { location: null },
    '/api/admin/reports': { reports: [], repos: [], maxBytes: 26_214_400 },
    '/api/admin/bundles': { bundles: [], repos: [], maxBytes: 209_715_200 },
    '/api/admin/history': { history: [], total: 0, page: 1, limit: 100, filters: { repos: [], users: [] } },
    '/api/admin/scan/models': { models: MANAGED_SCAN_MODELS, defaultModel: DEFAULT_MANAGED_SCAN_MODEL },
    '/api/admin/scan-results': { bundles: [], results: [] },
  }
  return Object.hasOwn(data, path) ? Response.json(data[path]) : Response.json({ error: 'not-found' }, { status: 404 })
}

const RAW_UPLOAD_BYTES = 3 * 1024 * 1024
const UPLOAD_PATHS = new Set(['/api/admin/reports', '/api/admin/bundles', '/api/admin/deduplication'])

// TLS-terminating proxies in front of the server would see file uploads, so
// seal them to this session's key (see upload-seal.ts). Servers that predate
// the key endpoint still receive the file as is: they answer 404, or 405 from
// their upload-part route.
async function sealBody(options, send) {
  const response = await send('/api/admin/uploads/key', { credentials: 'same-origin', signal: options.signal })
  if (response.status === 404 || response.status === 405) return options
  if (!response.ok) return response
  const key = (await response.json())?.key
  if (typeof key !== 'string') throw new Error('The server sent an invalid upload key')
  const headers = new Headers(options.headers)
  headers.set(UPLOAD_SEAL_HEADER, '1')
  return { ...options, headers, body: await sealUpload(options.body, Uint8Array.fromBase64(key, { alphabet: 'base64url' }), options.signal) }
}

// Large files are checked against the advertised limit before sealing. Each
// request is small enough for a function ingress; capability negotiation keeps
// local servers and older deployments on their existing raw upload API.
async function uploadFile(url, options, send) {
  let chunkBytes = null
  if (url !== '/api/admin/deduplication' && options.body.size > RAW_UPLOAD_BYTES) {
    const config = await send('/api/config', { credentials: 'same-origin', signal: options.signal })
    if (!config.ok) return config
    const managed = (await config.json()).managed
    const maxBytes = managed?.uploadMaxBytes?.[url.endsWith('/reports') ? 'reports' : 'bundles']
    if (Number.isSafeInteger(maxBytes) && maxBytes > 0 && options.body.size > maxBytes) return Response.json({ error: 'too-large' }, { status: 413 })
    const advertised = managed?.uploadChunkBytes
    if (Number.isSafeInteger(advertised) && advertised > 0 && advertised <= RAW_UPLOAD_BYTES) chunkBytes = advertised
  }
  const sealed = await sealBody(options, send)
  if (sealed instanceof Response) return sealed
  // Sealing adds 16 bytes per MiB to binary files, so a file under the raw
  // limit still fits one request.
  if (chunkBytes == null || sealed.body.size <= RAW_UPLOAD_BYTES) return await send(url, sealed)
  return await uploadInParts(url, sealed, send, chunkBytes)
}

async function uploadInParts(url, options, send, chunkBytes) {
  const file = options.body, id = crypto.randomUUID()
  const kind = url.endsWith('/reports') ? 'reports' : 'bundles'
  const count = Math.ceil(file.size / chunkBytes)
  const partHeaders = new Headers(options.headers)
  partHeaders.set('content-type', 'application/octet-stream')
  let attempted = 0, completed = false
  try {
    for (let index = 0; index < count; index++) {
      attempted = index + 1
      const response = await send(`/api/admin/uploads/${kind}/${id}/${index}`, {
        ...options, headers: partHeaders, body: file.slice(index * chunkBytes, (index + 1) * chunkBytes),
      })
      if (!response.ok) return response
    }
    const headers = new Headers(options.headers)
    headers.set('x-upload-id', id)
    headers.set('x-upload-parts', String(count))
    headers.set('x-upload-size', String(file.size))
    const response = await send(url, { ...options, headers, body: '' })
    completed = response.ok
    return response
  } finally {
    if (!completed && attempted > 0) {
      // Cancellation needs its own bounded signal. The session-generation
      // guard in send still prevents cleanup under a switched account.
      const headers = new Headers(options.headers)
      headers.set('x-upload-parts', String(attempted))
      await send(`/api/admin/uploads/${kind}/${id}`, {
        ...options, method: 'DELETE', headers, body: undefined, signal: AbortSignal.timeout(10000),
      }).catch(() => {}) // Preserve the upload error; the staging sweep retries cleanup.
    }
  }
}

export async function managedFetch(url, options) {
  options?.signal?.throwIfAborted()
  if (preview) return previewResponse(url, options)
  const started = generation
  async function send(target, init) {
    if (started !== generation) throw new DOMException('Managed session changed', 'AbortError')
    const share = getPublicShare()
    if (share) {
      const resolved = new URL(target, globalThis.location.origin)
      if (resolved.origin !== globalThis.location.origin) throw new Error('Public workspace requests must be same-origin')
      const headers = new Headers(init?.headers)
      headers.set('x-deepview-share', share.token)
      init = { ...init, headers, credentials: 'omit', redirect: 'error' }
    }
    const response = await fetch(target, { ...init, cache: 'no-store' })
    if (started !== generation) throw new DOMException('Managed session changed', 'AbortError')
    return response
  }
  if (options?.method === 'POST' && UPLOAD_PATHS.has(url) && options.body instanceof Blob) return await uploadFile(url, options, send)
  return await send(url, options)
}
