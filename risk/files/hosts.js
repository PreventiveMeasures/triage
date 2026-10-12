// The hosts a version's code names, and the services malicious packages send
// what they take to, for a reviewer: the hosts a version's scripts name that
// the version compared with's named in none of theirs, and an exfiltration
// host a file names, as a file's stamps say (stamps.js).
//
// A quick read, not a parse, as runs-code.js reads: a host is a URL's in a
// script's strings, regular expressions and template literals
// (JS_STRING_OR_COMMENT), its comments aside, where a link to docs is no host
// the code calls; an exfiltration host is told in any text but prose and a
// source map, wherever it is written. A host built as the code runs
// (`'https://' + name`, `${host}`) goes unseen, so a version without these
// labels is not one that sends nothing.
import { NPM_PROSE, SOURCE_MAP } from './readability.js'
import { JS_STRING_OR_COMMENT, NPM_MAX_FOUND, lineOf, npmIsScript } from './script.js'

// How many hosts a file is told naming at most, the first it names.
export const NPM_MAX_HOSTS = 1000

// A URL's host: a name whose last label is letters (an internationalized
// one's too, as written or as punycode), or an IPv4 address, after its
// scheme, as a regular expression may leave its `s` optional (`https?://`),
// and any user, its case aside; whole, not the start of one built as the code
// runs (`api.service.com.${tld}`).
const LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?`
const URL_HOST = new RegExp(String.raw`\b(?:https?|wss?|ftp)\??:\/\/(?:[^\s/@'"\x60]*@)?(${LABEL}(?:\.${LABEL})+)(?![\p{L}\p{N}-]|\.[\p{L}\p{N}_$-])`, 'giu')
const NAMED = /\.(?:\p{L}{2,}|xn--[a-z0-9-]+)$/u
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/u
// Hosts no code calls out to: this machine, the names kept for examples and
// tests (RFC 2606, RFC 6761) and local networks, and W3C's, whose URLs name
// XML namespaces.
const LOCAL = /^(?:localhost|.+\.(?:localhost|local|test|invalid|example|internal)|(?:.+\.)?example\.(?:com|net|org)|127(?:\.\d+){3}|0\.0\.0\.0|(?:.+\.)?w3\.org)$/u

// What a regular expression escapes in a URL, its slashes and dots
// (`/https:\/\/api\.example\.com/`), as a string may its slashes
// (`"https:\/\/api.example.com"`, as JSON can be written), read unescaped.
const ESCAPED = /\\([/.])/gu

// The hosts a script's strings name, each with the line it is first named on,
// in the order named, NPM_MAX_HOSTS at most; null for none, or for a file
// that is no script.
export function npmHosts(path, text) {
  if (!npmIsScript(path, text) || !(text.includes('://') || text.includes(':\\/\\/'))) return null
  const hosts = new Map(), line = lineOf(text)
  for (const { 1: token, index } of text.matchAll(JS_STRING_OR_COMMENT)) {
    if (hosts.size >= NPM_MAX_HOSTS) break
    // Read unescaped, its offsets as near: on the same line but in a template
    // across lines.
    const string = token?.includes('\\') ? token.replaceAll(ESCAPED, '$1') : token
    if (!string?.includes('://')) continue
    for (const { 1: name, index: at } of string.matchAll(URL_HOST)) {
      const host = name.toLowerCase()
      if (!hosts.has(host) && (NAMED.test(host) || IPV4.test(host)) && !LOCAL.test(host)) hosts.set(host, line(index + at))
      if (hosts.size >= NPM_MAX_HOSTS) break
    }
  }
  return hosts.size > 0 ? hosts : null
}

// A host as it is written, under another or not (`m.webhook.site`), then a
// path on it where only that path is the service (`/api/webhooks`), on its
// own: not part of a longer name (`notwebhook.site`, `webhook.sites`), a
// name under another domain (`webhook.site.evil.example`, `webhook.site.рф`),
// nor another path (`/install.sh`, `/api/webhooks.json`), though a sentence
// may end after it. Its name first, so a text is searched for that alone.
const NAME_CHAR = String.raw`[\p{L}\p{N}_-]`
const host = (name, path = '') => new RegExp(String.raw`(?<!${NAME_CHAR})${name}${path}(?!\.?${NAME_CHAR})`, 'giu')
// Services malicious packages send what they take to, or fetch what they run
// from: request catchers, out-of-band testing hosts (interactsh's, Burp
// Collaborator's), bot and webhook APIs, a paste site, an IP lookup, and the
// install script of Bun (`bun.sh/install`, now `bun.com/install`), which a
// worm ran its payload with.
export const EXFILTRATION = new Map([
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

// The exfiltration services a file names, each with the lines it is named on,
// the first NPM_MAX_FOUND, in EXFILTRATION's order; null for none, or for
// prose or a source map.
export function npmExfiltration(path, text) {
  if (typeof text !== 'string' || NPM_PROSE.test(path) || SOURCE_MAP.test(path) || !SAYS_ANY.test(text)) return null
  const found = new Map(), line = lineOf(text)
  for (const [service, { pattern }] of EXFILTRATION) {
    const lines = new Set()
    for (const { index } of text.matchAll(pattern)) if (lines.add(line(index)).size >= NPM_MAX_FOUND) break
    if (lines.size > 0) found.set(service, [...lines])
  }
  return found.size > 0 ? found : null
}
