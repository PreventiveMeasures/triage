// What risk reads of a version from npm's version document, as the npm viewer
// is served it (server-managed/npm-packages.ts npmManifest): the npm account
// that published it, or the CI that did by npm's trusted publishing, which of
// its accounts are known to publish (@preventive/publishers), whether npm
// keeps a provenance statement for it, the scripts npm runs installing it,
// its dependencies, and its deprecation.
import publishers from '@preventive/publishers/npm.js'
import { INSTALL_SCRIPTS } from './install-scripts.js'

const NPM_ACCOUNT = /^[\w.-]{1,214}$/u
// The npm accounts known to publish: those with standing on one of npm's
// most downloaded packages.
const KNOWN_PUBLISHERS = new Set(publishers.map(name => name.toLowerCase()))
const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const stringRecord = value => plainObject(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string')) : undefined

// One of package.json's people's name: `{ name }`, or `Name <email> (url)` in
// one string.
function personName(value) {
  const text = part => typeof part === 'string' && part.trim() !== '' ? part.trim() : null
  if (plainObject(value)) return text(value.name)
  return typeof value === 'string' ? text(/^([^<(]*)/u.exec(value)?.[1]) : null
}

// A version document's manifest, as risk reads it: `publisher` (or
// `trustedPublisher`), `knownAccounts`, `provenance`, `installScripts`,
// `dependencies`, `peerDependencies` and `optionalDependencies`, and
// `deprecated`, each where it has one.
export function npmVersionManifest(json) {
  const pick = {}
  if (typeof json?.deprecated === 'string') pick.deprecated = json.deprecated
  const publisher = personName(json?._npmUser)
  if (publisher && NPM_ACCOUNT.test(publisher)) pick.publisher = publisher
  else if (publisher && publisher.length <= 64 && plainObject(json._npmUser.trustedPublisher)) pick.trustedPublisher = publisher
  if (pick.publisher && KNOWN_PUBLISHERS.has(pick.publisher.toLowerCase())) pick.knownAccounts = [pick.publisher]
  for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const record = stringRecord(json?.[key])
    if (record && Object.keys(record).length > 0) pick[key] = record
  }
  if (plainObject(json?.dist) && plainObject(json.dist.attestations) && plainObject(json.dist.attestations.provenance)) pick.provenance = true
  const scripts = stringRecord(json?.scripts)
  const install = scripts ? INSTALL_SCRIPTS.filter(script => script in scripts) : []
  if (install.length > 0) pick.installScripts = Object.fromEntries(install.map(script => [script, scripts[script]]))
  return pick
}
