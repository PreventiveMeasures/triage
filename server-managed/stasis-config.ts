// stasis.config.json's `entries`, as `stasis bundle` takes them (Stasis's
// src/cmd/bundle-options.js, which is not a public package export): each
// entry it names, a path relative to the file's directory, -> that entry's
// options, `stasis bundle`'s flags by name. The entries it names are built
// with their options there and never with others; the rest never take them.
export const STASIS_CONFIG = 'stasis.config.json'
export const MAX_STASIS_CONFIG_BYTES = 256 * 1024

// An entry option's value as given: true (false is no option), a string, a
// list (comma-separated, or an array of them), or a define's KEY=VALUE texts
// (one, or an array).
type Kind = 'boolean' | 'string' | 'list' | 'define'
// The flags an entry may set, each with buildGitHubBundle's option for it.
// Whether one applies to its entry is Stasis's to say as it builds.
const ENTRY_OPTIONS: Record<string, [Kind, string]> = {
  mapping: ['string', 'mappingFile'],
  manifests: ['boolean', 'manifests'],
  scope: ['string', 'scope'],
  conditions: ['list', 'conditions'],
  mainFields: ['list', 'mainFields'],
  metro: ['boolean', 'metro'],
  'babel-aliases': ['string', 'babelAliases'],
  platforms: ['list', 'platforms'],
  jsx: ['boolean', 'jsx'],
  typescript: ['boolean', 'typescript'],
  tsconfig: ['string', 'tsconfig'],
  resources: ['list', 'resources'],
  'package-json': ['boolean', 'packageJSON'],
  define: ['define', 'define'],
  'cargo-features': ['list', 'cargoFeatures'],
  'cargo-no-default-features': ['boolean', 'cargoNoDefaultFeatures'],
  'cargo-all-features': ['boolean', 'cargoAllFeatures'],
  'cargo-manifests': ['boolean', 'cargoManifests'],
}
// The flags that run the project's code, or a program it names. `stasis
// bundle` takes one from stasis.config.json only with the same flag given as
// consent; a server build never runs one, so it has none to give.
const CODE_OPTIONS: Record<string, Kind> = { babel: 'boolean', 'metro-resolver': 'boolean', flow: 'boolean', cargo: 'boolean', 'cargo-target': 'string' }
// The bundle's own flags, which no entry sets.
const OUTPUT_OPTIONS = new Set(['output', 'lockfile', 'brotli-quality', 'add'])

export interface ConfigEntry {
  // The name as stasis.config.json writes it.
  entry: string
  // buildGitHubBundle's options for it, in one order whatever the file's.
  options: Record<string, unknown>
  // The first option it sets that runs code, null where none does.
  runs: string | null
}

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

function optionValue(what: string, flag: string, kind: Kind, value: unknown): unknown {
  if (kind === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${what}: ${flag} must be true or false`)
    return value
  }
  const many = kind !== 'string' && Array.isArray(value) && value.every(item => typeof item === 'string')
  if (typeof value !== 'string' && !many) throw new Error(`${what}: ${flag} must be a string${kind === 'string' ? '' : ' or an array of strings'}`)
  if (kind === 'string') return value
  if (kind === 'list') {
    const list = [value].flat().join(',').split(',').map(item => item.trim()).filter(Boolean)
    if (list.length === 0) throw new Error(`${what}: ${flag} must list at least one value`)
    return flag === 'platforms' ? [...new Set(list)] : list
  }
  // A define's VALUE is JSON, as `--define=KEY=VALUE` takes it.
  const define: Record<string, unknown> = {}
  const texts = [value].flat() as string[]
  if (texts.length === 0) throw new Error(`${what}: define must give at least one KEY=VALUE`)
  for (const text of texts) {
    const eq = text.indexOf('=')
    if (eq <= 0) throw new Error(`${what}: define must be KEY=VALUE, not ${JSON.stringify(text)}`)
    const key = text.slice(0, eq)
    if (Object.hasOwn(define, key)) throw new Error(`${what}: define gives ${key} a value twice`)
    try { define[key] = JSON.parse(text.slice(eq + 1)) } catch {
      throw new Error(`${what}: define's value for ${key} must be JSON, not ${JSON.stringify(text.slice(eq + 1))}`)
    }
  }
  return define
}

function entryOptions(what: string, given: unknown): Pick<ConfigEntry, 'options' | 'runs'> {
  if (!plainObject(given)) throw new Error(`${what} must be an object of stasis bundle options`)
  const values = new Map<string, unknown>()
  let runs: string | null = null
  for (const [flag, value] of Object.entries(given)) {
    if (OUTPUT_OPTIONS.has(flag)) throw new Error(`${what}: ${flag} is the bundle's option, not an entry's`)
    const kind = Object.hasOwn(ENTRY_OPTIONS, flag) ? ENTRY_OPTIONS[flag]![0] : Object.hasOwn(CODE_OPTIONS, flag) ? CODE_OPTIONS[flag]! : null
    if (kind === null) throw new Error(`${what}: unknown option ${JSON.stringify(flag)}`)
    const parsed = optionValue(what, flag, kind, value)
    if (parsed === false) continue
    if (Object.hasOwn(CODE_OPTIONS, flag)) runs ??= flag
    else values.set(flag, parsed)
  }
  const options: Record<string, unknown> = {}
  for (const [flag, [, option]] of Object.entries(ENTRY_OPTIONS)) if (values.has(flag)) options[option] = values.get(flag)
  return { options, runs }
}

// The `entries` of the stasis.config.json in `directory` whose text is
// `text`: each entry it names, as a path from there -> its ConfigEntry. null
// where it names none. What `stasis bundle` would refuse to read throws.
export function parseStasisConfig(text: string, directory = ''): Map<string, ConfigEntry> | null {
  const file = directory ? `${directory}/${STASIS_CONFIG}` : STASIS_CONFIG
  let config: unknown
  try { config = JSON.parse(text) } catch (cause) { throw new Error(`${file} is not valid JSON`, { cause }) }
  const entries = plainObject(config) ? config['entries'] : undefined
  if (entries === undefined) return null
  if (!plainObject(entries)) throw new Error(`${file}: entries must be an object of each entry's stasis bundle options`)
  const named = new Map<string, ConfigEntry>()
  for (const [entry, options] of Object.entries(entries)) {
    const what = `${file}: entries ${JSON.stringify(entry)}`
    const key = configEntryKey(directory, entry)
    if (key === null) throw new Error(`${what}: an entry must be a path relative to the directory of ${STASIS_CONFIG}, within it`)
    if (named.has(key)) throw new Error(`${what} names the same entry as ${JSON.stringify(named.get(key)!.entry)}`)
    named.set(key, { entry, ...entryOptions(what, options) })
  }
  return named
}
