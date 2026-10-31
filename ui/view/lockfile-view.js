// The Code tab's View lockfile toggle (state.bundleSourceLockfile): a lockfile
// open in the code viewer, shown in the lockfile viewer (lockfile-graph.js) in
// its source's place, as a pretty-printed copy is (pretty-source.js). Its
// readers load the first time a lockfile is viewed (lockfile-read.js).
import { state } from '#client/index.js'

// The lockfiles the viewer reads, by name (lockfile-read.js): npm's; pnpm's,
// of a git branch too; Yarn's, of which the reader tells Yarn 1's from a
// later one by its text; and each other @preventive/lockfile reads: Bundler's,
// Cargo's, CocoaPods', Composer's, Poetry's, uv's, PEP 751's (named or not),
// Soldeer's and forge's.
const LOCKFILES = new Map([
  ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'],
  ['Gemfile.lock', 'bundler'], ['gems.locked', 'bundler'], ['Cargo.lock', 'cargo'], ['Podfile.lock', 'cocoapods'],
  ['composer.lock', 'composer'], ['poetry.lock', 'poetry'], ['uv.lock', 'uv'], ['pylock.toml', 'pylock'],
  ['soldeer.lock', 'soldeer'], ['foundry.lock', 'foundry'],
])
export function lockfileFormat(path) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (LOCKFILES.has(name)) return LOCKFILES.get(name)
  if (/^pnpm-lock\..+\.yaml$/u.test(name)) return 'pnpm'
  if (/^pylock\.[^.]+\.toml$/u.test(name)) return 'pylock'
  return null
}

// The manifest beside a lockfile its reader takes, where the lockfile alone
// doesn't say what the project asks for: Yarn's package.json, Composer's
// composer.json.
const MANIFESTS = new Map([['yarn', 'package.json'], ['composer', 'composer.json']])
export const lockfileManifest = format => MANIFESTS.get(format) ?? null

// Lockfiles read, by bundle and path, the most recent last; a few kept, as a
// large one's graph is large.
const KEPT_READS = 4
const reads = new Map()

// A lockfile's read while the toggle is on, begun the first time it is
// wanted, `notify` called once it ends; null while it is off. `sources` are
// the bundle's files, where a lockfile finds its manifest (lockfileManifest).
export function viewedLockfile(details, path, content, sources, notify) {
  if (!state.bundleSourceLockfile) return null
  const format = lockfileFormat(path)
  if (format === null) return null
  const key = `${details.integrity}\0${path}`
  const read = reads.get(key) ?? { status: 'loading' }
  reads.delete(key)
  reads.set(key, read)
  for (const old of reads.keys()) if (reads.size > KEPT_READS) reads.delete(old)
  if (read.status === 'loading' && !read.started) {
    read.started = true
    const manifestName = lockfileManifest(format)
    const manifest = manifestName === null ? undefined : sources.get(`${path.slice(0, path.lastIndexOf('/') + 1)}${manifestName}`)
    import('./lockfile-read.js')
      .then(({ readLockfile }) => readLockfile(format, content, { manifest }))
      .then(lockfile => Object.assign(read, { status: 'ready', lockfile: { id: key, ...lockfile } }))
      .catch(err => Object.assign(read, { status: 'error', message: err instanceof Error ? err.message : String(err) }))
      .finally(notify)
  }
  return read
}

// Turned back on, the toggle reads again lockfiles whose read failed: the
// reader's chunk may not have loaded.
export function toggleLockfileView() {
  state.bundleSourceLockfile = !state.bundleSourceLockfile
  for (const [key, read] of reads) if (read.status === 'error') reads.delete(key)
}

// What a View lockfile toggle says of its lockfile's read.
export const lockfileTooltip = read => read?.status === 'loading' ? 'Reading the lockfile…'
  : read?.status === 'error' ? `Couldn't read the lockfile: ${read.message}` : 'View lockfile'
