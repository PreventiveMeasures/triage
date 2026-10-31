// stasis.config.json's `entries`, as Stasis reads them (src/cmd/bundle-options.js's
// readConfigEntries, which is not a public package export): the entries it
// names, each a path relative to the file's directory. Their options are
// Stasis's: buildGitHubBundle builds the entries the stasis.config.json in its
// directory names with their options there, and refuses what it can't build.
export const STASIS_CONFIG = 'stasis.config.json'
export const MAX_STASIS_CONFIG_BYTES = 256 * 1024

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

// `entry` as a path from `directory` ('.' for it), as `stasis bundle` run
// there resolves it; null where that is outside it.
export function configEntryKey(directory: string, entry: string): string | null {
  if (entry.startsWith('/')) return null
  const base = directory ? directory.split('/') : []
  const parts = [...base]
  for (const part of entry.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') parts.push(part)
    else if (parts.pop() === undefined) return null
  }
  if (base.some((part, i) => parts[i] !== part)) return null
  return parts.slice(base.length).join('/') || '.'
}

// The entries the stasis.config.json in `directory` whose text is `text`
// names, each as a path from there; null where it has no `entries`. One whose
// entries Stasis can't tell throws.
export function parseStasisConfig(text: string, directory = ''): Set<string> | null {
  const file = directory ? `${directory}/${STASIS_CONFIG}` : STASIS_CONFIG
  let config: unknown
  try { config = JSON.parse(text) } catch (cause) { throw new Error(`${file} is not valid JSON`, { cause }) }
  const entries = plainObject(config) ? config['entries'] : undefined
  if (entries === undefined) return null
  if (!plainObject(entries)) throw new Error(`${file}: entries must be an object of each entry's stasis bundle options`)
  const named = new Map<string, string>()
  for (const entry of Object.keys(entries)) {
    const what = `${file}: entries ${JSON.stringify(entry)}`
    const key = configEntryKey(directory, entry)
    if (key === null) throw new Error(`${what}: an entry must be a path relative to the directory of ${STASIS_CONFIG}, within it`)
    if (named.has(key)) throw new Error(`${what} names the same entry as ${JSON.stringify(named.get(key))}`)
    named.set(key, entry)
  }
  return new Set(named.keys())
}
