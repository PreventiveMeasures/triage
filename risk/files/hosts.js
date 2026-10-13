// The hosts a version's code names, and the services malicious packages send
// what they take to, fetch what they run from or look the machine up with,
// for a reviewer: the hosts a version's scripts name that the version
// compared with's named in none of theirs, and the services a file names,
// under a tag for how much they call for (HOST_TAGS: Exfiltration, Remote,
// IP lookup), as a file's stamps say (stamps.js).
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
const NPM_MAX_HOSTS = 1000

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

// The pages github.com shows of a repository that a person reads, past its
// owner and name, as links and error messages name them.
const GITHUB_PAGES = new Set(['issues', 'pull', 'pulls', 'blob', 'tree', 'wiki', 'discussions', 'commit', 'commits', 'compare', 'blame',
  'security', 'actions', 'projects', 'labels', 'milestone', 'milestones', 'releases', 'tags', 'graphs', 'network', 'stargazers'])
// How a github.com URL (`url`, as written from its scheme on) is named among
// a file's hosts, read as fetch reads it (WHATWG URL: a port, a trailing dot,
// backslashes as slashes, `..` resolved): `github.com` for its home or a
// person's, a repository's home, a page a person reads (GITHUB_PAGES), a
// release's page (`releases/tag/v1`, `releases/latest`) but not its assets'
// (`releases/latest/download/…`), and a file's page but not the file raw
// (`blob/…?raw=true`). Any other path (`raw/…`, `archive/…`, `tarball`,
// `repo.git`, one GitHub may add, one read otherwise) leads to whatever a
// repository holds: named by it (`github.com/owner/repo`), so that it is
// never taken for one of github.com's links to code and docs (compare.js
// ALLOWED_HOSTS).
const RAW = /[?&]raw=(?:true|1)(?:&|$)/u
const decoded = part => { try { return decodeURIComponent(part) } catch { return part } }
function githubNamed(url) {
  let parsed = null
  try { parsed = new URL(url.replace(/^(\w+)\?:/u, '$1:')) } catch {}
  if (!parsed) return 'github.com/'
  const segments = parsed.pathname.split('/').slice(1)
  if (segments.length > 1 && segments.at(-1) === '') segments.pop()
  const [owner, repo = '', section, ...rest] = segments
  const page = parsed.hostname.replace(/\.$/u, '') === 'github.com' && (segments.length === 1 || (owner !== '' && repo !== '' && !repo.endsWith('.git')
    && (section === undefined || GITHUB_PAGES.has(section)) && !(section === 'releases' && rest.includes('download')) && !(section === 'blob' && RAW.test(parsed.search))))
  return page ? 'github.com' : `github.com/${decoded(owner)}/${decoded(repo.replace(/\.git$/u, ''))}`
}

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
      const named = host === 'github.com' ? githubNamed(/^[^\s'"\u0060]*/u.exec(string.slice(at))[0]) : host
      if (!hosts.has(named) && (NAMED.test(host) || IPV4.test(host)) && !LOCAL.test(host)) hosts.set(named, line(index + at))
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
// One so like a file's name or code (`transfer.sh`, `file.io`) only as a
// URL's host: after the `//` that starts its authority (or `\/\/` as JSON can
// write it), where the URL starts, its scheme as URL_HOST takes one after the
// text's start, a blank, a quote, `(`, `=`, `,`, `<` or `>`, or without one
// after a quote, `(`, `=` or `,` (`"//file.io/x"`): not a URL's path, whatever
// it holds (`https://example.com/a//transfer.sh`, `/http://transfer.sh`); and
// after any user, not a user itself (`https://transfer.sh@example.com`).
const inUrl = name => new RegExp(String.raw`(?<=(?:(?:^|[\s'"\x60(=,<>])(?:https?|wss?|ftp)\??:|['"\x60(=,])\\?\/\\?\/(?:[^\s/@'"\x60]*@)?(?:${NAME_CHAR}+\.)*)${name}(?!\.?${NAME_CHAR}|(?::[^\s/@'"\x60]*)?@)`, 'giu')
// The tags the services go under, each with its severity (stamps.js
// SEVERITIES), as a change between versions raises it (npmHostSeverity):
// Exfiltration, `critical` (red), where nothing but catching what is sent
// has a use for it in a package's code; Remote, `high` (orange), where it
// could be fine; and IP lookup, `moderate` (yellow), where it usually is.
export const HOST_TAGS = new Map([['Exfiltration', 'critical'], ['Remote', 'high'], ['IP lookup', 'moderate']])
const [CATCHER, REMOTE, IP_LOOKUP] = [...HOST_TAGS.keys()].map(tag => ({ tag }))
// Services malicious packages send what they take to, fetch what they run
// from, or look the machine up with, each under its tag. Exfiltration's:
// request catchers, and out-of-band testing hosts (interactsh's, Burp
// Collaborator's, Canarytokens', DNS logs). Remote's: bot and webhook APIs,
// paste sites and file drops, tunnels, Pipedream's own API (its endpoints
// are `pipedream.net`), and the install script of Bun (`bun.sh/install`, now
// `bun.com/install`), which a worm ran its payload with. And IP lookups.
export const EXFILTRATION = new Map([
  ['webhook-site', { ...CATCHER, name: 'webhook.site', pattern: host(String.raw`webhook\.site`) }],
  ['pipedream', { ...CATCHER, name: 'Pipedream', pattern: host(String.raw`pipedream\.net`) }],
  ['requestbin', { ...CATCHER, name: 'RequestBin', pattern: host(String.raw`(?:requestbin\.(?:net|com)|requestb\.in)`) }],
  ['requestcatcher', { ...CATCHER, name: 'Request Catcher', pattern: host(String.raw`requestcatcher\.com`) }],
  ['requestrepo', { ...CATCHER, name: 'requestrepo', pattern: host(String.raw`requestrepo\.com`) }],
  ['beeceptor', { ...CATCHER, name: 'Beeceptor', pattern: host(String.raw`beeceptor\.com`) }],
  ['oast', { ...CATCHER, name: 'OAST', pattern: host(String.raw`(?:interact\.sh|interactsh\.com|oast\.(?:pro|live|site|online|fun|me)|oastify\.com|burpcollaborator\.net)`) }],
  ['canarytokens', { ...CATCHER, name: 'Canarytokens', pattern: host(String.raw`canarytokens\.(?:com|org)`) }],
  ['dnslog', { ...CATCHER, name: 'DNSLog', pattern: host(String.raw`dnslog\.cn`) }],
  ['ceye', { ...CATCHER, name: 'CEYE', pattern: host(String.raw`ceye\.io`) }],
  ['telegram', { ...REMOTE, name: 'Telegram', pattern: host(String.raw`api\.telegram\.org`) }],
  ['discord', { ...REMOTE, name: 'Discord webhook', pattern: host(String.raw`discord(?:app)?\.com`, String.raw`/api(?:/v\d+)?/webhooks`) }],
  ['slack', { ...REMOTE, name: 'Slack webhook', pattern: host(String.raw`hooks\.slack\.com`, '/(?:services|workflows|triggers)') }],
  ['pastebin', { ...REMOTE, name: 'Pastebin', pattern: host(String.raw`pastebin\.com`) }],
  ['paste-ee', { ...REMOTE, name: 'paste.ee', pattern: host(String.raw`paste\.ee`) }],
  ['transfer-sh', { ...REMOTE, name: 'transfer.sh', pattern: inUrl(String.raw`transfer\.sh`) }],
  ['file-io', { ...REMOTE, name: 'file.io', pattern: inUrl(String.raw`file\.io`) }],
  ['0x0', { ...REMOTE, name: '0x0.st', pattern: host(String.raw`0x0\.st`) }],
  ['ngrok', { ...REMOTE, name: 'ngrok', pattern: host(String.raw`ngrok(?:-free)?\.(?:io|app|dev)`) }],
  ['localtunnel', { ...REMOTE, name: 'localtunnel', pattern: host(String.raw`loca\.lt`) }],
  ['cloudflare-tunnel', { ...REMOTE, name: 'Cloudflare Tunnel', pattern: host(String.raw`trycloudflare\.com`) }],
  ['serveo', { ...REMOTE, name: 'Serveo', pattern: host(String.raw`serveo\.net`) }],
  ['pipedream-api', { ...REMOTE, name: 'Pipedream API', pattern: host(String.raw`pipedream\.com`) }],
  ['bun', { ...REMOTE, name: 'Bun install', pattern: host(String.raw`bun\.(?:sh|com)`, '/install') }],
  ['ipinfo', { ...IP_LOOKUP, name: 'ipinfo', pattern: host(String.raw`ipinfo\.io`) }],
  ['ipify', { ...IP_LOOKUP, name: 'ipify', pattern: host(String.raw`ipify\.org`) }],
  ['ifconfig-me', { ...IP_LOOKUP, name: 'ifconfig.me', pattern: host(String.raw`ifconfig\.me`) }],
  ['icanhazip', { ...IP_LOOKUP, name: 'icanhazip', pattern: host(String.raw`icanhazip\.com`) }],
  ['ip-api', { ...IP_LOOKUP, name: 'ip-api', pattern: host(String.raw`ip-api\.com`) }],
  ['ipapi', { ...IP_LOOKUP, name: 'ipapi', pattern: host(String.raw`ipapi\.com?`) }],
  ['checkip', { ...IP_LOOKUP, name: 'checkip', pattern: host(String.raw`checkip\.amazonaws\.com`) }],
])
// Any of them, as a text may say it: most say none, told at once.
const SAYS_ANY = new RegExp([...EXFILTRATION.values()].map(({ pattern }) => pattern.source).join('|'), 'iu')

// The services a file names, each with the lines it is named on, the first
// NPM_MAX_FOUND, in EXFILTRATION's order; null for none, or for prose or a
// source map.
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

// The services of `found` under `tag` (HOST_TAGS), in their order; null for
// none.
export function npmHostsTagged(found, tag) {
  const tagged = found && new Map([...found].filter(([service]) => EXFILTRATION.get(service).tag === tag))
  return tagged?.size > 0 ? tagged : null
}

// The services a file names (`found`) by their tag, in HOST_TAGS' order:
// `[tag, services]` each.
export const npmHostTags = found => [...HOST_TAGS.keys()].map(tag => [tag, npmHostsTagged(found, tag)]).filter(([, services]) => services)

// How severe a tag's `services` are: its own severity, or with `was` (null for
// a file that held none), where one of them the file didn't name, a level
// higher, never past `critical`, as a change between versions calls for more.
export function npmHostSeverity(tag, services, was) {
  const levels = [...HOST_TAGS.values()]
  const at = levels.indexOf(HOST_TAGS.get(tag))
  return levels[was !== undefined && [...services.keys()].some(service => !was?.has(service)) ? Math.max(0, at - 1) : at]
}
