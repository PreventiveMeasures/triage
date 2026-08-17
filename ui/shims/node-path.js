// Browser stand-ins for the node builtins `@exodus/stasis-core` imports.
// Its util.js pulls `node:buffer` / `node:fs` / `node:path` / `node:util`
// at module top level, which the browser bundle can't resolve — but the
// only util function the UI ever executes is `posixPathEscapes` (on the
// `Bundle.parse` path in view/bundle-load.js), and the only Node API it
// touches is `posix.normalize` / `posix.isAbsolute`. build.js aliases the
// four builtins onto these shims: this file implements that posix subset
// for real; every other export (here and in the sibling shims) exists
// purely to satisfy import linking and throws if reached, so a stub can't
// silently stand in for behavior the UI has started to rely on.

export function isAbsolute(path) {
  return path.startsWith('/')
}

// Mirrors `node:path`'s posix.normalize for the shapes posixPathEscapes
// feeds it: resolve `.` / `..` segments, collapse repeated slashes, keep
// the absolute prefix and trailing slash. `..` above the root is kept for
// relative paths (`a/../../b` → `../b`) and dropped for absolute ones
// (`/../a` → `/a`) — the exact property the escape check relies on.
export function normalize(path) {
  if (path === '') return '.'
  const abs = path.startsWith('/')
  const trailing = path.endsWith('/')
  const out = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out.at(-1) !== '..') out.pop()
      else if (!abs) out.push('..')
    } else {
      out.push(seg)
    }
  }
  let result = out.join('/')
  if (result === '') return abs ? '/' : (trailing ? './' : '.')
  if (trailing) result += '/'
  return abs ? `/${result}` : result
}

export const posix = { isAbsolute, normalize }

const stub = (name) => () => { throw new Error(`node:path ${name}() is not available in the browser bundle`) }
export const basename = stub('basename')
export const join = stub('join')
export const relative = stub('relative')
