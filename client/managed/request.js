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
    '/api/admin/history': { history: [], total: 0, page: 1, limit: 100 },
    '/api/admin/models': { models: MANAGED_SCAN_MODELS, defaultModel: DEFAULT_MANAGED_SCAN_MODEL },
    '/api/admin/scan-results': { bundles: [], results: [] },
  }
  return Object.hasOwn(data, path) ? Response.json(data[path]) : Response.json({ error: 'not-found' }, { status: 404 })
}

export async function managedFetch(url, options) {
  options?.signal?.throwIfAborted()
  if (preview) return previewResponse(url, options)
  const started = generation
  // Managed data lives on the server; it must not enter the browser HTTP cache.
  const response = await fetch(url, { ...options, cache: 'no-store' })
  if (started !== generation) throw new DOMException('Managed session changed', 'AbortError')
  return response
}
