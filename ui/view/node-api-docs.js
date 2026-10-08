// Node.js built-in modules, as `require('node:module').builtinModules` lists
// them less the undocumented `_`-prefixed internals, and their documentation.
// The browser has no `isBuiltin`, so the list is kept here.
const BUILTINS = new Set([
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises',
  'http', 'http2', 'https', 'inspector', 'inspector/promises', 'module', 'net', 'os', 'path', 'path/posix',
  'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'repl',
  'stream', 'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers',
  'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
])
// Only reachable with the `node:` scheme: a bare `test` is an npm package.
const SCHEME_ONLY = new Set(['sea', 'sqlite', 'test', 'test/reporters'])
// Modules documented under another page or a section of one. The rest have
// a page of their own name.
const PAGES = {
  __proto__: null,
  'assert/strict': 'assert.html#strict-assertion-mode',
  constants: 'deprecations.html#DEP0008',
  'dns/promises': 'dns.html#dns-promises-api',
  'fs/promises': 'fs.html#promises-api',
  'inspector/promises': 'inspector.html#promises-api',
  'path/posix': 'path.html#pathposix',
  'path/win32': 'path.html#pathwin32',
  'readline/promises': 'readline.html#promises-api',
  sea: 'single-executable-applications.html',
  'stream/consumers': 'webstreams.html#utility-consumers',
  'stream/promises': 'stream.html#streams-promises-api',
  'stream/web': 'webstreams.html',
  sys: 'deprecations.html#DEP0025',
  'test/reporters': 'test.html#test-reporters',
  'timers/promises': 'timers.html#timers-promises-api',
  trace_events: 'tracing.html',
  'util/types': 'util.html#utiltypes',
}

// The built-in module a specifier names, without its `node:` scheme, or null.
export function nodeBuiltinName(specifier) {
  if (typeof specifier !== 'string') return null
  if (specifier.startsWith('node:')) {
    const name = specifier.slice(5)
    return BUILTINS.has(name) || SCHEME_ONLY.has(name) ? name : null
  }
  return BUILTINS.has(specifier) ? specifier : null
}

export function nodeApiDocUrl(name) {
  return `https://nodejs.org/api/${PAGES[name] ?? `${name}.html`}`
}
