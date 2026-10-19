// What a published version's document tells of it as the npm viewer's
// Overview shows it (npmManifest), and the fields of the document read for it
// and for the version itself (npm-packages.ts readNpmVersion), the rest
// stripped where it is kept (npmVersionFields).
import publishers from '@preventive/publishers/npm.js'
import { getRepo } from '@preventive/upstream/package.js'

export const plainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
export const stringRecord = (value: unknown) => plainObject(value)
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string')) as Record<string, string> : undefined

interface NpmPerson { name: string | null; email: string | null }
const NPM_ACCOUNT = /^[\w.-]{1,214}$/u
// The npm accounts known to publish: those with standing on one of npm's
// most downloaded packages (@preventive/publishers).
const KNOWN_PUBLISHERS = new Set(publishers.map(name => name.toLowerCase()))

// One of package.json's people: `{ name, email, url }`, or `Name <email>
// (url)` in one string.
function npmPerson(value: unknown): NpmPerson | null {
  const text = (part: unknown) => typeof part === 'string' && part.trim() !== '' ? part.trim() : null
  if (plainObject(value)) return { name: text(value['name']), email: text(value['email']) }
  if (typeof value !== 'string') return null
  const parts = /^([^<(]*)(?:<([^>]*)>)?\s*(?:\([^)]*\))?\s*$/u.exec(value)
  return parts ? { name: text(parts[1]), email: text(parts[2]) } : { name: text(value), email: null }
}

// The GitLab project (`group/project`, subgroups and all) a package names as
// its repository, in any of the forms npm takes (`gitlab:group/project`,
// `git@gitlab.com:…`, `git+https://gitlab.com/….git`); null for another.
// GitLab's are only on gitlab.com, as npm's provenance has them.
function gitlabProject(repository: unknown): string | null {
  const url = typeof repository === 'string' ? repository : plainObject(repository) && typeof repository['url'] === 'string' ? repository['url'] : ''
  if (url.length > 2048) return null
  const project = /^(?:gitlab:|git@gitlab\.com:|(?:git\+)?(?:https|ssh|git):\/\/(?:git@)?gitlab\.com\/)([\w.-]+(?:\/[\w.-]+)+)\/?$/u
    .exec(url.split('/-/')[0]!)?.[1]?.replace(/\.git$/u, '')
  return project && !project.split('/').some(part => /^\.+$/u.test(part)) ? project : null
}

// The fields the Overview shows, in the shapes package.json gives them; each
// left out where the document has none, or has another shape. A homepage that
// leads only where its repository does (the repository, its directory there,
// or its readme, npm's homepage where the package names none) is left out.
export function npmManifest(json: Record<string, unknown>): Record<string, unknown> {
  const pick: Record<string, unknown> = {}
  for (const key of ['description', 'license', 'homepage', 'main', 'module', 'types', 'type', 'deprecated', 'gitHead']) {
    if (typeof json[key] === 'string') pick[key] = json[key]
  }
  // Its author's name, and their npm account where it can be told: the
  // publisher's or a maintainer's whose email or name is the author's. Emails
  // only match people up; none is kept.
  const author = npmPerson(json['author'])
  if (author?.name) pick['author'] = author.name
  const accounts = [json['_npmUser'], ...Array.isArray(json['maintainers']) ? json['maintainers'] : []].map(npmPerson)
    .filter((person): person is NpmPerson & { name: string } => person?.name != null && NPM_ACCOUNT.test(person.name))
  // The npm account that published it, for its profile; or, published by
  // a CI npm trusts (npm's trusted publishing), the CI, as npm names it
  // (`GitHub Actions`).
  const publisher = npmPerson(json['_npmUser'])?.name
  if (publisher && NPM_ACCOUNT.test(publisher)) pick['publisher'] = publisher
  else if (publisher && publisher.length <= 64 && plainObject(json['_npmUser']) && plainObject(json['_npmUser']['trustedPublisher'])) pick['trustedPublisher'] = publisher
  const same = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase()
  const account = author && accounts.find(person => same(person.email, author.email) || same(person.name, author.name))
  if (account) pick['authorAccount'] = account.name
  // Which of those accounts are known to publish, for the Overview to tell
  // them from the rest.
  const known = [...new Set([publisher, account?.name])].filter(name => name && KNOWN_PUBLISHERS.has(name.toLowerCase()))
  if (known.length > 0) pick['knownAccounts'] = known
  if (Array.isArray(json['keywords'])) pick['keywords'] = json['keywords'].filter(item => typeof item === 'string').slice(0, 50)
  if (typeof json['bin'] === 'string') pick['bin'] = { [String(json['name'])]: json['bin'] }
  else if (stringRecord(json['bin'])) pick['bin'] = stringRecord(json['bin'])
  for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies', 'engines']) {
    const record = stringRecord(json[key])
    if (record && Object.keys(record).length > 0) pick[key] = record
  }
  if (json['hasInstallScript'] === true) pick['hasInstallScript'] = true
  // Whether npm keeps a provenance statement for it (npm-provenance.ts).
  if (plainObject(json['dist']) && plainObject(json['dist']['attestations']) && plainObject(json['dist']['attestations']['provenance'])) pick['provenance'] = true
  // The scripts npm runs installing it from the registry; not `prepare`,
  // which runs only for a local or git install.
  const scripts = stringRecord(json['scripts'])
  const install = scripts ? ['preinstall', 'install', 'postinstall'].filter(script => script in scripts) : []
  if (install.length > 0) pick['installScripts'] = Object.fromEntries(install.map(script => [script, scripts![script]]))
  // A GitLab project it names, as its provenance's source is matched with
  // the repository it names, GitHub's below.
  const gitlab = gitlabProject(json['repository'])
  if (gitlab) pick['gitlab'] = gitlab
  try {
    const repo = getRepo(json)
    if (repo.github) {
      pick['github'] = { github: repo.github, ...(repo.directory === undefined ? {} : { directory: repo.directory }) }
      const home = typeof pick['homepage'] === 'string' ? getRepo({ homepage: pick['homepage'] }) : {}
      if (home.github?.toLowerCase() === repo.github.toLowerCase() && (home.directory ?? '') === (repo.directory ?? '')) delete pick['homepage']
    }
  } catch {}
  return pick
}

// Of a version's document, the fields readNpmVersion and npmManifest read,
// of `dist` and `scripts` only theirs, and of a provenance statement only that
// there is one: what is kept of it (npm-kept.ts), so that both read a kept one
// as they read npm's.
const VERSION_FIELDS = ['name', 'version', 'description', 'license', 'homepage', 'main', 'module', 'types', 'type', 'deprecated', 'gitHead', 'author', '_npmUser',
  'maintainers', 'keywords', 'bin', 'dependencies', 'peerDependencies', 'optionalDependencies', 'engines', 'hasInstallScript', 'repository', 'bugs']
const DIST_FIELDS = ['tarball', 'integrity', 'shasum', 'unpackedSize', 'fileCount']
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall']
const picked = (json: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(json, key)).map(key => [key, json[key]]))

export function npmVersionFields(json: Record<string, unknown>): Record<string, unknown> {
  const dist = plainObject(json['dist']) ? json['dist'] : {}
  const provenance = plainObject(dist['attestations']) && plainObject(dist['attestations']['provenance'])
  const scripts = picked(stringRecord(json['scripts']) ?? {}, INSTALL_SCRIPTS)
  return { ...picked(json, VERSION_FIELDS), dist: { ...picked(dist, DIST_FIELDS), ...provenance && { attestations: { provenance: {} } } },
    ...Object.keys(scripts).length > 0 && { scripts } }
}
