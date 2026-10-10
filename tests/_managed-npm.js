// npm registry fixtures for the managed npm tests: packages as npm packs
// them, and a registry serving them.
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

export const REGISTRY = 'https://registry.npmjs.org'

// A ustar archive of `entries`, each `{ name, data, type, prefix }`, as npm pack writes one.
export function tar(entries) {
  const blocks = []
  for (const { name, data = '', type = '0', prefix = '' } of entries) {
    const body = Buffer.from(data)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100)
    header.write('0000644\0', 100)
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.write(type, 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.write(prefix, 345, 155)
    header.write('        ', 148)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)])
}

export function packageOf(name, version, files, extra = {}) {
  const tgz = gzipSync(tar(Object.entries(files).map(([path, data]) => ({ name: `package/${path}`, data }))))
  const base = name.split('/').at(-1)
  const doc = { name, version, description: `${name} for tests`, license: 'MIT', main: 'lib/index.js',
    repository: { type: 'git', url: 'git+https://github.com/org/repo.git', directory: 'packages/pkg' }, gitHead: 'a'.repeat(40),
    dependencies: { dep: '^1.0.0' }, scripts: { postinstall: 'node setup.js', test: 'node --test' }, _npmUser: { name: 'publisher-1', email: 'p@example.com' },
    dist: { tarball: `${REGISTRY}/${name}/-/${base}-${version}.tgz`, integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`, unpackedSize: 100, fileCount: 2 }, ...extra }
  return { doc, tgz }
}

// The registry: public packages answer anyone; private ones only the token.
export function registry(t, packages) {
  const calls = []
  t.mock.method(globalThis, 'fetch', (input, init = {}) => {
    const url = String(input)
    const headers = new Headers(init.headers)
    const auth = headers.get('authorization')
    calls.push({ url, auth })
    for (const { doc, tgz, private: secret, versions } of packages) {
      if (secret && auth !== `Bearer ${process.env['NPM_TOKEN']}`) continue
      if (url === `${REGISTRY}/${doc.name}/${encodeURIComponent(doc.version)}` || url === `${REGISTRY}/${doc.name}/latest`) return Promise.resolve(Response.json(doc))
      if (url === `${REGISTRY}/${doc.name}`) {
        const listed = versions ?? [doc.version]
        // The whole document has when each was published, the abbreviated one not.
        const time = headers.get('accept') === 'application/json'
          ? { time: { created: '2020-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', ...Object.fromEntries(listed.map((v, i) => [v, `2025-0${i + 1}-01T00:00:00.000Z`])) } } : {}
        return Promise.resolve(Response.json({ name: doc.name, 'dist-tags': { latest: doc.version, next: '9.9.9' }, versions: Object.fromEntries(listed.map(v => [v, {}])), ...time }))
      }
      if (url === doc.dist.tarball) return Promise.resolve(new Response(tgz))
    }
    return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
  })
  return calls
}

// The server's npm token, for a test.
export function withToken(t, token = 'server-token') {
  const previous = process.env['NPM_TOKEN']
  process.env['NPM_TOKEN'] = token
  t.after(() => { if (previous === undefined) delete process.env['NPM_TOKEN']; else process.env['NPM_TOKEN'] = previous })
}
