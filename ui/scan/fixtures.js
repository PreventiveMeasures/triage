import { formatBytes } from './metrics.js'

// Managed scan fixtures are deliberately UI-first for now. The managed API will own
// bundle discovery, reason metadata, file previews, scan execution, and report
// persistence; these fixtures keep the flow reviewable before those endpoints
// exist and exercise the same states the real response will provide.
const SCAN_PACKAGE_NAMES = ['@acme/auth', '@acme/billing', '@acme/catalog', '@acme/checkout', '@acme/config', '@acme/crypto', '@acme/data', '@acme/identity', '@acme/notifications', '@acme/payments', '@acme/search', '@acme/storage', '@acme/telemetry', '@acme/ui', '@acme/users', '@acme/webhooks']
const SCAN_LARGE_BUNDLE_FILES = Array.from({ length: 128 }, (_, index) => {
  const module = SCAN_PACKAGE_NAMES[index % SCAN_PACKAGE_NAMES.length]
  const bytes = 9_000 + ((index * 7_300) % 48_000)
  return { path: `packages/${module.slice(6)}/src/file-${String(index + 1).padStart(3, '0')}.ts`, bytes, lines: 180 + ((index * 137) % 960), module }
})

export const SCAN_REPOSITORY_FIXTURES = [
  { id: 'repo-checkout', label: 'acme/checkout' },
  { id: 'repo-worker', label: 'acme/worker-service' },
  { id: 'unattached', label: 'Unattached' },
]

const SCAN_BUNDLE_FIXTURES = [
  {
    id: 'bundle-checkout', filename: 'checkout.stasis', repoId: 'repo-checkout', repo: 'acme/checkout', size: '48.2 MiB', files: [
      { path: 'src/auth/session.ts', bytes: 82_000, lines: 1640, module: '@acme/auth' },
      { path: 'src/payments/checkout.ts', bytes: 74_000, lines: 1480, module: '@acme/payments' },
      { path: 'src/api/routes.ts', bytes: 61_000, lines: 1220, module: '@acme/api' },
      { path: 'src/users/permissions.ts', bytes: 42_000, lines: 840, module: '@acme/users' },
      { path: 'src/crypto/tokens.ts', bytes: 36_000, lines: 720, module: '@acme/crypto' },
      { path: 'src/db/queries.ts', bytes: 29_000, lines: 580, module: '@acme/database' },
      { path: 'src/webhooks/stripe.ts', bytes: 22_000, lines: 440, module: '@acme/payments' },
      { path: 'src/config/env.ts', bytes: 13_000, lines: 260, module: '@acme/config' },
      ...SCAN_LARGE_BUNDLE_FILES,
    ],
    reasons: [
      { id: 'all', label: 'All', fileModules: null },
      { id: 'run', label: 'run', fileModules: null },
      { id: 'app', label: 'app', fileModules: ['@acme/auth', '@acme/payments', '@acme/api', '@acme/users', '@acme/crypto', '@acme/config', ...SCAN_PACKAGE_NAMES] },
    ],
  },
  {
    id: 'bundle-worker', filename: 'worker.stasis', repoId: 'repo-worker', repo: 'acme/worker-service', size: '16.7 MiB', files: [
      { path: 'worker/queue.ts', bytes: 54_000, lines: 1080, module: 'queue' },
      { path: 'worker/handlers/process.ts', bytes: 48_000, lines: 960, module: 'handlers' },
      { path: 'worker/handlers/retry.ts', bytes: 31_000, lines: 620, module: 'handlers' },
      { path: 'worker/secrets.ts', bytes: 19_000, lines: 380, module: 'secrets' },
      { path: 'worker/metrics.ts', bytes: 12_000, lines: 240, module: 'metrics' },
    ],
    reasons: [{ id: 'all', label: 'All', fileModules: null }, { id: 'run', label: 'run', fileModules: ['queue', 'handlers', 'secrets', 'metrics'] }, { id: 'app', label: 'app', fileModules: ['queue', 'handlers', 'metrics'] }],
  },
  {
    id: 'bundle-unattached', filename: 'detached-preview.stasis', repoId: 'unattached', repo: 'Unattached', size: '6.4 MiB', files: [
      { path: 'src/index.ts', bytes: 31_000, lines: 620, module: 'preview' },
      { path: 'src/loader.ts', bytes: 24_000, lines: 480, module: 'preview' },
      { path: 'src/manifest.ts', bytes: 18_000, lines: 360, module: 'preview' },
      { path: 'src/worker.ts', bytes: 15_000, lines: 300, module: 'worker' },
    ],
    reasons: [{ id: 'all', label: 'All', fileModules: null }, { id: 'run', label: 'run', fileModules: ['preview', 'worker'] }],
  },
]

export const SCAN_FIXTURES = [
  { id: 'scan-104', bundleId: 'bundle-checkout', bundleName: 'checkout.stasis', reason: 'app', status: 'completed', createdAt: 'Today, 09:42', duration: '4m 18s', files: 5, reportSaved: true },
  { id: 'scan-103', bundleId: 'bundle-worker', bundleName: 'worker.stasis', reason: 'All', status: 'running', createdAt: 'Today, 09:51', duration: '1m 06s', files: 5, reportSaved: false },
  { id: 'scan-102', bundleId: 'bundle-checkout', bundleName: 'checkout.stasis', reason: 'run', status: 'stopped', createdAt: 'Yesterday, 17:20', duration: '38s', files: 4, reportSaved: false },
]

export function cloneScanFixtures() {
  return SCAN_BUNDLE_FIXTURES.map((bundle) => ({
    ...bundle,
    files: bundle.files.map((file) => ({ ...file, size: formatBytes(file.bytes) })),
    reasons: bundle.reasons.map((reason) => ({ ...reason, fileModules: reason.fileModules ? [...reason.fileModules] : null })),
  }))
}
