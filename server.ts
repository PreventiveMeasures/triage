import { parseArgs } from 'node:util'
import type { Server } from 'node:http'
import { startServer } from './server-common/standalone.ts'

// The reviewed dependencies a host keeps beyond the app, registered before
// init() (server-managed/reviewed-dependencies.ts): an async method telling
// whether a dependency, as a lockfile locks it, is reviewed there
// (`lookup`), and optionally one reading the reviews an open pull request's
// comments make (`parseComments`), and one formatting one's own dependency
// reviews as a comment to copy (`formatDependencyReviews`). They replace a
// repository's commit its dependencies are reviewed since.
export { registerReviewedDependencies } from './server-managed/reviewed-dependencies.ts'
export type { CommentReview, DependencyReviewEntry, FormatDependencyReviewsInput, ParseCommentsInput, ReviewComment, ReviewedDependencies, ReviewedDependency,
  ReviewedLockfile, ReviewedVersion, ReviewVerdict } from './server-managed/reviewed-dependencies.ts'

const modes = ['e2e', 'managed', 'managed-e2e', 'e2e-managed'] as const
export type ServerMode = typeof modes[number]

function parseMode(mode: string): ServerMode {
  for (const candidate of modes) if (mode === candidate) return candidate
  throw new Error(`Unknown mode: ${mode}. Expected ${modes.join(', ')}.`)
}

// Assemble the selected server without binding a port. Hosts can reuse its
// request/upgrade listeners or call listen() themselves.
export async function init(mode: ServerMode = 'e2e'): Promise<Server> {
  const selected = parseMode(mode)
  if (selected === 'e2e') {
    const { createE2eApp } = await import('./server-e2e/app.ts')
    return (await createE2eApp()).httpServer
  }
  if (selected === 'managed') {
    const managed = await import('./server-managed/index.ts')
    return managed.init()
  }
  const combined = await import('./server-managed/combined.ts')
  return combined.init(selected === 'managed-e2e' ? 'managed+e2e' : 'e2e+managed')
}

export async function start(): Promise<void> {
  const { values } = parseArgs({ options: {
    mode: { type: 'string', default: 'e2e' },
    help: { type: 'boolean', short: 'h' },
  } })
  const mode = parseMode(values.mode)
  if (values.help) {
    console.log(`Usage: node cli.js --mode <${modes.join('|')}>
Defaults to e2e. Combined modes share HOST/PORT; the first mode is the client default.
Managed modes require GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and OAUTH_CALLBACK_URL.
Combined storage: DATABASE_URL for a shared Neon DB, or E2E_DATABASE_URL and
MANAGED_DATABASE_URL for separate Neon DBs. Do not mix shared and per-mode URLs.
Without URLs: SQLite at DB_PATH for e2e and MANAGED_DB_PATH for managed.
Combined mode does not support mixing Neon and SQLite.`)
  } else {
    const config = mode === 'managed'
      ? (await import('./server-managed/config.ts')).loadManagedConfig()
      : (await import('./server-e2e/config.ts')).loadConfig()
    const server = await init(mode)
    startServer(server, config)
  }
}
