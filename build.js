// esbuild driver. We can't use the bare CLI because Lit components
// want to import their own `.css` files as text strings (so the bytes
// end up inside shadow DOM via unsafeCSS), while the top-level
// `ui/*.css` entries still need to bundle as actual stylesheets. A
// single `--loader:.css=...` flag can't express both, and esbuild
// doesn't yet support `with { type: 'text' }` or bundled
// `import source` for .css. The plugin below routes JS-imported `.css`
// through the `text` loader and leaves entry-point CSS alone.
import * as esbuild from 'esbuild'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, resolve as resolvePath, dirname } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { minify as oxcMinify } from 'oxc-minify'
import { buildId, stampedHtml } from './build-id.js'
import { escapedControls } from './build-controls.js'
import { minifyLitSource } from './build-lit-minify.js'
import { litSvgAsHtml } from './build-lit-svg.js'
import { parseManagedRoute } from './common/managed/routes.js'
import { managedPageHtml } from './server-managed/static.ts'
import { DEFAULT_SCAN_SERVER } from './common/scan-server.ts'
import { configuredScanServer, scanServerHtml } from './server-common/scan-config.ts'

// `minify` is set in prod builds. esbuild's top-level `minify` flag
// doesn't reach text-loaded contents, so we run a one-shot
// `esbuild.transform` with `loader: 'css'` on each shadow-DOM
// stylesheet here. That collapses whitespace, drops comments, and
// shortens hex colors before the bytes get baked into the JS bundle
// as a string literal — meaningful since some component sheets are
// several KB. Dev (serve) skips it: minified CSS is harder to
// inspect via the devtools, and the bundle size doesn't matter when
// it's served from memory on localhost.
const litCssAsText = ({ minify } = {}) => ({
  name: 'lit-css-as-text',
  setup(build) {
    build.onResolve({ filter: /\.css$/ }, (args) => {
      // Entry points have no importer; fall through to the default
      // css loader. We only redirect imports originating from JS.
      if (!args.importer || !args.importer.endsWith('.js')) return null
      return {
        path: resolvePath(dirname(args.importer), args.path),
        namespace: 'lit-css',
      }
    })
    build.onLoad({ filter: /.*/, namespace: 'lit-css' }, async (args) => {
      let contents = await readFile(args.path, 'utf8')
      if (minify) {
        const result = await esbuild.transform(contents, { loader: 'css', minify: true })
        contents = result.code
      }
      return { contents, loader: 'text' }
    })
  },
})

// Minify the static parts of `html\`…\`` and `css\`…\`` tagged
// template literals before esbuild parses the JS source. The same
// engine the rollup-plugin-minify-html-literals-v3 plugin wraps —
// we just plug it into esbuild's onLoad, with the one adjustment
// `build-lit-minify.js` explains (a style attribute's expression
// must keep what follows it). Skipped on node_modules
// (no Lit-tagged literals worth minifying live there) and skipped
// in serve mode so source maps + readable templates survive in
// devtools. Library returns null when a file has no literals; we
// pass through unchanged in that case.
const minifyLitTemplates = {
  name: 'minify-lit-templates',
  setup(build) {
    build.onLoad({ filter: /\.js$/ }, async (args) => {
      if (args.path.includes('/node_modules/')) return null
      const source = await readFile(args.path, 'utf8')
      try {
        const code = minifyLitSource(source, args.path)
        if (code === null) return null
        return { contents: code, loader: 'js' }
      } catch (err) {
        return {
          contents: source,
          loader: 'js',
          warnings: [{ text: `minify-html-literals skipped: ${err.message}` }],
        }
      }
    })
  },
}

const mode = process.argv[2] ?? 'build'
if (mode === 'build') {
  // Chunk names carry a content hash, so a rebuild adds files rather than
  // overwriting them. Start from an empty out/: anything left over would be
  // served by the static servers and published via `out/chunk-*.js`.
  await rm('out', { recursive: true, force: true })
  // The brotli fallback builds on its own, without splitting: it runs as
  // a worker whose response carries `default-src 'none'`
  // (server-e2e/static.ts), and Firefox fetches a module worker's static
  // imports under that policy, so an import of a shared chunk is refused
  // and the worker dies before it decodes anything. (Chromium fetches
  // them under the page's policy, which admits them.) Alone it imports
  // nothing; the CommonJS helpers it would share are a few hundred bytes.
  const scripts = (await readdir('ui')).filter(name => name.endsWith('.js') && name !== 'brotli-fallback.js').map(name => `ui/${name}`)
  const [{ metafile }, { metafile: fallbackMetafile }] = await Promise.all([esbuild.build({
    bundle: true,
    plugins: [minifyLitTemplates, litCssAsText({ minify: true }), litSvgAsHtml],
    entryPoints: [...scripts, 'ui/*.css', 'ui/*.html', 'ui/*.svg', 'ui/*.webmanifest'],
    loader: { '.html': 'copy', '.svg': 'copy', '.webmanifest': 'copy' },
    outdir: 'out',
    minify: true,
    // index.html loads view.js with `type="module"`, and splitting needs
    // ESM output for its chunks.
    format: 'esm',
    // Code shared between entries (lit, the scan page, report parsing…)
    // lands once in a chunk instead of in every bundle that uses it, so a
    // lazy bundle loads only what view.js doesn't already have, and both
    // share one module instance. Chunks keep a fixed prefix for the
    // package.json `files` list.
    splitting: true,
    chunkNames: 'chunk-[hash]',
    metafile: true,
  }), esbuild.build({
    bundle: true,
    entryPoints: ['ui/brotli-fallback.js'],
    outdir: 'out',
    minify: true,
    // ESM output so its `export brotliDecompress` survives the bundle and
    // the runtime `await import('./brotli-fallback.js')` gets a real module
    // namespace. With the IIFE default, exports were silently dropped and
    // the dynamic import resolved to an empty namespace ("brotliDecompress
    // is not a function"). The dedicated worker `view/brotli-decompress.js`
    // spawns from the same file with `{ type: 'module' }` to match.
    format: 'esm',
    metafile: true,
  })])
  if (fallbackMetafile.outputs['out/brotli-fallback.js'].imports.length) throw new Error('out/brotli-fallback.js imports a module, which its worker may not load')
  const outputs = { ...metafile.outputs, ...fallbackMetafile.outputs }
  // One module, one output. Lazy entries (graph.js, scan.js, dialogs.js…)
  // take lit and the client state from the chunks view.js loads; a copy of
  // their own would be a second lit, a second set of custom elements, a
  // second state, which splitting in this one build rules out. Hold to it.
  const owners = new Map()
  for (const [output, { inputs }] of Object.entries(outputs)) {
    if (!output.endsWith('.js')) continue
    for (const input of Object.keys(inputs)) {
      if (owners.has(input)) throw new Error(`${input} is in both ${owners.get(input)} and ${output}`)
      owners.set(input, output)
    }
  }
  // esbuild's output goes through oxc-minify once more (installed as
  // @preventive/compare's peer): it compresses further than esbuild's
  // minifier, out/'s JavaScript some 2.6% smaller under Brotli. It keeps the
  // licence comments esbuild kept, which it drops by default. A chunk's name
  // stays esbuild's hash of its own output, which oxc-minify turns into the
  // same file each time. Then the control characters both print raw, escaped
  // again (build-controls.js).
  await Promise.all(Object.keys(outputs).filter(path => path.endsWith('.js')).map(async path => {
    const { code, errors } = await oxcMinify(path, await readFile(path, 'utf8'), { module: true, codegen: { legalComments: 'inline' } })
    if (errors.length) throw new Error(`oxc-minify failed on ${path}: ${errors.map(e => e.message).join('; ')}`)
    await writeFile(path, escapedControls(code))
  }))
  // view.js imports its chunks itself, but the browser only sees those
  // imports once view.js has arrived. Preload them beside it so they
  // download in parallel (the static server lifts these into a Link header).
  const chunks = metafile.outputs['out/view.js'].imports.filter(i => i.kind === 'import-statement').map(i => basename(i.path))
  const index = await readFile('out/index.html', 'utf8')
  const preload = '<link rel="modulepreload" href="./view.js" />'
  if (!index.includes(preload)) throw new Error('out/index.html lost its view.js modulepreload')
  await writeFile('out/index.html', index.replace(preload, [preload, ...chunks.map(c => `<link rel="modulepreload" href="./${c}" />`)].join('\n')))
  // Each page names the build of the scripts and styles it loads, and asks
  // for its own and the bundles it loads at runtime under it (build-id.js).
  const id = buildId(await Promise.all(Object.keys(outputs).filter(path => /\.(?:css|js)$/u.test(path)).map(async path => [path, await readFile(path)])))
  for (const name of (await readdir('out')).filter(name => name.endsWith('.html'))) await writeFile(`out/${name}`, stampedHtml(await readFile(`out/${name}`, 'utf8'), id))
} else if (mode === 'serve') {
  const scanServer = configuredScanServer(process.env['DEEPVIEW_SCAN_SERVER']) ?? DEFAULT_SCAN_SERVER
  // Mirror the previous `--servedir=ui --outdir=ui` setup: esbuild
  // builds js/css in memory and serves them overlaid on the static
  // source tree. HTML is intentionally NOT an entry point — the
  // `ui/*.html` files are already served as static assets via
  // servedir, and routing them through esbuild with `outdir=ui`
  // would try to write over the source.
  const ctx = await esbuild.context({
    bundle: true,
    plugins: [litCssAsText(), litSvgAsHtml],
    entryPoints: ['ui/*.js', 'ui/*.css'],
    outdir: 'ui',
    // The CLI's --serve flag implies both write:false and tolerating
    // an outdir that overlaps with input files; the JS API does
    // neither implicitly. write:false keeps the build in memory, and
    // allowOverwrite silences the "refusing to overwrite input file"
    // check (which fires before write would happen).
    write: false,
    allowOverwrite: true,
    format: 'esm',
    splitting: true,
    chunkNames: 'chunk-[hash]',
  })
  // Bind esbuild on an ephemeral port — the proxy below is the visible
  // dev origin on PROXY_PORT (default 8000), esbuild lives behind it.
  // Single-origin dev means the UI's WebSocket / objstore fetches can
  // use plain relative URLs and skip CORS, matching the production
  // topology where a fronting nginx routes `/api/*` to server-e2e/ and
  // `/*` to the static bundle.
  const esb = await ctx.serve({ host: '127.0.0.1', port: 0, servedir: 'ui' })

  // Backend target = server-e2e/index.ts. Default to its env-var defaults
  // (HOST=127.0.0.1, PORT=8765) so a plain `node server-e2e/index.ts` on
  // the side Just Works; override with BACKEND_HOST / BACKEND_PORT
  // when the operator picked custom values for the server process.
  const backendHost = process.env['BACKEND_HOST'] ?? '127.0.0.1'
  const backendPort = Number(process.env['BACKEND_PORT'] ?? 8765)
  const proxyHost = process.env['PROXY_HOST'] ?? '127.0.0.1'
  const proxyPort = Number(process.env['PROXY_PORT'] ?? 8000)

  // Same `/api/*` prefix convention `server-e2e/index.ts` enforces for the
  // WS upgrade path + REST routes. Keep this in sync with the server's
  // `WS_UPGRADE_PATH` and `matchRoute` if either ever moves off `/api`.
  const isApi = (url) => typeof url === 'string' && /^\/api(?:[/?]|$)/u.test(url)

  const proxy = createServer((req, res) => {
    // HTML is served from source in dev. Apply the same CSP transform as the
    // E2E static server without writing configuration into source files.
    const pathname = new URL(req.url ?? '/', 'http://dev.invalid').pathname
    const managedPage = !['/', '/index.html'].includes(pathname) && parseManagedRoute(new URL(req.url, 'http://dev.invalid')) != null
    if (((scanServer && ['/', '/index.html'].includes(pathname)) || managedPage) && ['GET', 'HEAD'].includes(req.method)) {
      void readFile('ui/index.html', 'utf8').then(html => {
        const configuredHtml = scanServerHtml(html, scanServer, { advertise: true })
        const body = managedPage ? managedPageHtml(configuredHtml) : configuredHtml
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : body)
      }).catch(err => { res.writeHead(500); res.end(String(err)) })
      return
    }
    const target = isApi(req.url) ? { host: backendHost, port: backendPort, label: 'backend' } : { host: esb.host, port: esb.port, label: 'esbuild' }
    const upstream = httpRequest({
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: req.headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstream.on('error', (err) => {
      // Backend down is the common case during dev (operator hasn't
      // started `node server-e2e/index.ts` yet); emit a readable 502 so
      // the browser console shows the cause instead of a generic
      // connection reset.
      const body = `Dev proxy: ${target.label} (${target.host}:${target.port}) unreachable — ${err.message}\n`
      if (res.headersSent) { res.destroy(); return }
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(body)
    })
    req.on('error', () => { upstream.destroy() })
    req.pipe(upstream)
  })

  // WS upgrade proxy: replay the request line + raw headers onto a raw
  // TCP socket to the backend, then bidirectionally pipe. `http.request`
  // does have an `upgrade` event, but its handling of the 101 response
  // is more brittle (header casing, trailing data) than a straight
  // socket forward — and the backend already speaks HTTP/1.1 upgrades
  // natively via `ws`. esbuild's serve doesn't use WS for live-reload
  // (it uses SSE on `/esbuild` when enabled), so any non-/api/ upgrade
  // is unexpected and we drop it.
  proxy.on('upgrade', (req, clientSocket, head) => {
    if (!isApi(req.url)) { clientSocket.destroy(); return }
    const upstream = netConnect(backendPort, backendHost, () => {
      let headers = ''
      // `rawHeaders` preserves casing and duplicate headers, both of
      // which can matter to the WS handshake (Sec-WebSocket-Key etc.).
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        headers += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
      }
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n`)
      if (head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })

  proxy.listen(proxyPort, proxyHost, () => {
    console.log(`dev proxy: http://${proxyHost}:${proxy.address().port} → esbuild :${esb.port}, /api/* → ${backendHost}:${backendPort}`)
  })
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(1)
}
