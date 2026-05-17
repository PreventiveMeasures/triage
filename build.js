// esbuild driver. We can't use the bare CLI because Lit components
// want to import their own `.css` files as text strings (so the bytes
// end up inside shadow DOM via unsafeCSS), while the top-level
// `ui/*.css` entries still need to bundle as actual stylesheets. A
// single `--loader:.css=...` flag can't express both, and esbuild
// doesn't yet support `with { type: 'text' }` or bundled
// `import source` for .css. The plugin below routes JS-imported `.css`
// through the `text` loader and leaves entry-point CSS alone.
import * as esbuild from 'esbuild'
import { readFile } from 'node:fs/promises'
import { resolve as resolvePath, dirname } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { minifyHTMLLiterals } from 'minify-html-literals'

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
// we just plug it into esbuild's onLoad. Skipped on node_modules
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
        const result = minifyHTMLLiterals(source, { fileName: args.path })
        if (!result) return null
        return { contents: result.code, loader: 'js' }
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
  await esbuild.build({
    bundle: true,
    plugins: [minifyLitTemplates, litCssAsText({ minify: true })],
    entryPoints: ['ui/*.js', 'ui/*.css', 'ui/*.html'],
    loader: { '.html': 'copy' },
    outdir: 'out',
    minify: true,
    // ESM output so the brotli-fallback entry's `export
    // brotliDecompress` survives the bundle and the runtime
    // `await import('./brotli-fallback.js')` from view.js gets a
    // real module namespace. With the IIFE default, exports were
    // silently dropped and the dynamic import resolved to an empty
    // namespace ("brotliDecompress is not a function"). index.html
    // already loads view.js with `type="module"`, so ESM is
    // expected on the page side too.
    format: 'esm',
  })
} else if (mode === 'serve') {
  // Mirror the previous `--servedir=ui --outdir=ui` setup: esbuild
  // builds js/css in memory and serves them overlaid on the static
  // source tree. HTML is intentionally NOT an entry point — the
  // `ui/*.html` files are already served as static assets via
  // servedir, and routing them through esbuild with `outdir=ui`
  // would try to write over the source.
  const ctx = await esbuild.context({
    bundle: true,
    plugins: [litCssAsText()],
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
  })
  // Bind esbuild on an ephemeral port — the proxy below is the visible
  // dev origin on PROXY_PORT (default 8000), esbuild lives behind it.
  // Single-origin dev means the UI's WebSocket / objstore fetches can
  // use plain relative URLs and skip CORS, matching the production
  // topology where a fronting nginx routes `/api/*` to server/ and
  // `/*` to the static bundle.
  const esb = await ctx.serve({ host: '127.0.0.1', port: 0, servedir: 'ui' })

  // Backend target = server/index.ts. Default to its env-var defaults
  // (HOST=127.0.0.1, PORT=8765) so a plain `node server/index.ts` on
  // the side Just Works; override with BACKEND_HOST / BACKEND_PORT
  // when the operator picked custom values for the server process.
  const backendHost = process.env['BACKEND_HOST'] ?? '127.0.0.1'
  const backendPort = Number(process.env['BACKEND_PORT'] ?? 8765)
  const proxyHost = process.env['PROXY_HOST'] ?? '127.0.0.1'
  const proxyPort = Number(process.env['PROXY_PORT'] ?? 8000)

  // Same `/api/*` prefix convention `server/index.ts` enforces for the
  // WS upgrade path + REST routes. Keep this in sync with the server's
  // `WS_UPGRADE_PATH` and `matchRoute` if either ever moves off `/api`.
  const isApi = (url) => typeof url === 'string' && url.startsWith('/api/')

  const proxy = createServer((req, res) => {
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
      // started `node server/index.ts` yet); emit a readable 502 so
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
    console.log(`dev proxy: http://${proxyHost}:${proxyPort} → esbuild :${esb.port}, /api/* → ${backendHost}:${backendPort}`)
  })
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(1)
}
