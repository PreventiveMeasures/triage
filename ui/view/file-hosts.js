// The hosts a version's code names, and the services malicious packages send
// what they take to, for a reviewer: Compare's chips on hosts its scripts name
// that the version compared with's named in none of theirs, and an
// exfiltration host a file names, labelled wherever the file is listed.
//
// A quick read, not a parse, as file-runs-code.js reads: a host is a URL's in a
// script's strings, regular expressions and template literals
// (JS_STRING_OR_COMMENT), its comments aside, where a link to docs is no host
// the code calls; an exfiltration host is told in any text but prose and a
// source map, wherever it is written. A host built as the code runs
// (`'https://' + name`, `${host}`) goes unseen, so a version without these
// labels is not one that sends nothing.
import { html, nothing } from 'lit'
import { JS_STRING_OR_COMMENT, NPM_PROSE } from './file-readability.js'
import { npmIsScript } from './file-runs-code.js'

// A URL's host: a name whose last label is letters, or an IPv4 address, after
// its scheme and any user, its case aside; whole, not the start of one built
// as the code runs (`api.service.com.${tld}`).
const URL_HOST = /\b(?:https?|wss?|ftp):\/\/(?:[^\s/@'"`]*@)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?![a-z0-9-]|\.[\w$-])/giu
const NAMED = /\.[a-z]{2,}$/u
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/u
// Hosts no code calls out to: this machine, the names kept for examples and
// tests (RFC 2606, RFC 6761) and local networks, and W3C's, whose URLs name
// XML namespaces.
const LOCAL = /^(?:localhost|.+\.(?:localhost|local|test|invalid|example|internal)|(?:.+\.)?example\.(?:com|net|org)|127(?:\.\d+){3}|0\.0\.0\.0|(?:.+\.)?w3\.org)$/u

// Where each offset is, as its line: one more than the line breaks before it.
function lineOf(text) {
  let breaks = null
  return offset => {
    breaks ??= [...text.matchAll(/\n/gu)].map(({ index }) => index)
    let high = breaks.length, low = 0
    while (low < high) {
      const middle = (low + high) >> 1
      if (breaks[middle] < offset) low = middle + 1
      else high = middle
    }
    return low + 1
  }
}

// What a regular expression escapes in a URL, its slashes and dots
// (`/https:\/\/api\.example\.com/`), read as written in a string.
const ESCAPED = /\\([/.])/gu

// The hosts a script's strings name, each with the line it is first named on,
// in the order named; null for none, or for a file that is no script.
export function npmHosts(path, text) {
  if (!npmIsScript(path, text) || !(text.includes('://') || text.includes(':\\/\\/'))) return null
  const hosts = new Map(), line = lineOf(text)
  for (const { 1: token, index } of text.matchAll(JS_STRING_OR_COMMENT)) {
    // A regular expression's escapes read as a string's, its offsets as near.
    const string = token?.[0] === '/' ? token.replaceAll(ESCAPED, '$1') : token
    if (!string?.includes('://')) continue
    for (const { 1: name, index: at } of string.matchAll(URL_HOST)) {
      const host = name.toLowerCase()
      if (!hosts.has(host) && (NAMED.test(host) || IPV4.test(host)) && !LOCAL.test(host)) hosts.set(host, line(index + at))
    }
  }
  return hosts.size > 0 ? hosts : null
}

// A host as it is written, under another or not (`m.webhook.site`), then a
// path on it where only that path is the service (`/api/webhooks`), on its
// own: not part of a longer name (`notwebhook.site`, `webhook.sites`), a
// name under another domain (`webhook.site.evil.example`), nor another path
// (`/install.sh`, `/api/webhooks.json`), though a sentence may end after it.
// Its name first, so a text is searched for that alone.
const host = (name, path = '') => new RegExp(String.raw`(?<![\w-])${name}${path}(?!\.?[\w-])`, 'giu')
// Services malicious packages send what they take to, or fetch what they run
// from: request catchers, out-of-band testing hosts (interactsh's, Burp
// Collaborator's), bot and webhook APIs, a paste site, an IP lookup, and the
// install script of Bun (`bun.sh/install`, now `bun.com/install`), which a
// worm ran its payload with.
const EXFILTRATION = new Map([
  ['webhook-site', { name: 'webhook.site', pattern: host(String.raw`webhook\.site`) }],
  ['pipedream', { name: 'Pipedream', pattern: host(String.raw`pipedream\.(?:net|com)`) }],
  ['oast', { name: 'OAST', pattern: host(String.raw`(?:interact\.sh|interactsh\.com|oast\.(?:pro|live|site|online|fun|me)|oastify\.com|burpcollaborator\.net)`) }],
  ['telegram', { name: 'Telegram', pattern: host(String.raw`api\.telegram\.org`) }],
  ['discord', { name: 'Discord webhook', pattern: host(String.raw`discord(?:app)?\.com`, String.raw`/api(?:/v\d+)?/webhooks`) }],
  ['slack', { name: 'Slack webhook', pattern: host(String.raw`hooks\.slack\.com`, '/(?:services|workflows|triggers)') }],
  ['pastebin', { name: 'Pastebin', pattern: host(String.raw`pastebin\.com`) }],
  ['ipinfo', { name: 'ipinfo', pattern: host(String.raw`ipinfo\.io`) }],
  ['bun', { name: 'Bun install', pattern: host(String.raw`bun\.(?:sh|com)`, '/install') }],
])
// Any of them, as a text may say it: most say none, told at once.
const SAYS_ANY = new RegExp([...EXFILTRATION.values()].map(({ pattern }) => pattern.source).join('|'), 'iu')
const SOURCE_MAP = /\.map$/iu

// The exfiltration services a file names, each with the lines it is named on,
// in EXFILTRATION's order; null for none, or for prose or a source map.
export function npmExfiltration(path, text) {
  if (typeof text !== 'string' || NPM_PROSE.test(path) || SOURCE_MAP.test(path) || !SAYS_ANY.test(text)) return null
  const found = new Map(), line = lineOf(text)
  for (const [service, { pattern }] of EXFILTRATION) {
    const lines = [...new Set([...text.matchAll(pattern)].map(({ index }) => line(index)))]
    if (lines.length > 0) found.set(service, lines)
  }
  return found.size > 0 ? found : null
}

// npmHosts and npmExfiltration of a bundle's file, by bundle and path, each
// read once for the Files list and Compare.
function cached(read) {
  const byDetails = new WeakMap()
  return (details, path, text) => {
    let files = byDetails.get(details)
    if (!files) byDetails.set(details, files = new Map())
    if (!files.has(path)) files.set(path, read(path, text))
    return files.get(path)
  }
}
export const npmFileHosts = cached(npmHosts)
export const npmFileExfiltration = cached(npmExfiltration)

const linesNote = lines => lines.length === 1 ? `line ${lines[0]}`
  : `lines ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ` and ${(lines.length - 5).toLocaleString('en')} more` : ''}`

// The services `found` names that `was` didn't, each with its lines: those new
// to a file, `was` null for one the version compared with didn't hold. Null
// for none.
export function npmExfiltrationAdded(found, was) {
  if (!found) return null
  const added = new Map([...found].filter(([service]) => !was?.has(service)))
  return added.size > 0 ? added : null
}

// The services any of `founds` names, by name, in their order: `webhook.site, Telegram`.
export const npmExfiltrationNames = founds => [...EXFILTRATION].filter(([service]) => founds.some(found => found.has(service))).map(([, { name }]) => name).join(', ')

// The services a file names, each with its lines: `Telegram (line 3)`; with
// `was`, those it didn't name saying so.
export const npmExfiltrationSaid = (found, was) => [...found].map(([service, lines]) =>
  `${EXFILTRATION.get(service).name} (${linesNote(lines)}${was !== undefined && !was?.has(service) ? ', new' : ''})`).join(', ')

// A file's Exfiltration tag where it names any of the services, in orange as
// what it runs is (file-runs-code.js), naming them and their lines in its
// tooltip; with `was`, the services it named as the version compared with has
// it (null for none), one it didn't saying so.
export function npmExfiltrationTag(found, was) {
  if (!found) return nothing
  return html`<span class="npm-exfiltration" data-tooltip=${`Names a host malicious packages send what they take to: ${npmExfiltrationSaid(found, was)}`}>Exfiltration</span>`
}
