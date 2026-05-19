// rolldown driver. We can't use the bare CLI because Lit components
// want to import their own `.css` files as text strings (so the bytes
// end up inside shadow DOM via unsafeCSS), while the top-level
// `ui/*.css` entries still need to bundle as actual stylesheets. The
// plugin below routes JS-imported `.css` through the text loader and
// leaves entry-point CSS to be bundled separately by lightningcss
// (which resolves `@import`s and minifies).
import { build as rolldownBuild, watch as rolldownWatch } from 'rolldown'
import { bundle as lightningBundle, transform as lightningTransform } from 'lightningcss'
import { readFile, writeFile, mkdir, copyFile, readdir, rm, stat } from 'node:fs/promises'
import { createReadStream, watch as fsWatch } from 'node:fs'
import { resolve as resolvePath, dirname, join as joinPath, basename, extname } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { minifyHTMLLiterals } from 'minify-html-literals'

// `minify` is set in prod builds. JS minification (rolldown's oxc
// minifier) doesn't reach the contents of a string literal, so we
// run each shadow-DOM stylesheet through lightningcss here to
// collapse whitespace, drop comments, and shorten hex colors
// before the bytes get baked into the JS bundle as a string. Dev
// (serve) skips it: minified CSS is harder to inspect via the
// devtools, and the bundle size doesn't matter when it's served
// from a local proxy on localhost.
const litCssAsText = ({ minify } = {}) => ({
  name: 'lit-css-as-text',
  // Entry points have no importer; fall through to the default
  // resolution (and rolldown's default css handling). We only
  // redirect imports originating from JS.
  resolveId(source, importer) {
    if (!source.endsWith('.css')) return null
    if (!importer || !importer.endsWith('.js')) return null
    const resolved = resolvePath(dirname(importer), source)
    // Virtual id with the resolved path baked in so the load hook
    // can read the file off disk. The leading NUL keeps the id
    // out of file-system resolution paths.
    return `\0lit-css:${resolved}`
  },
  async load(id) {
    if (!id.startsWith('\0lit-css:')) return null
    const filePath = id.slice('\0lit-css:'.length)
    let contents = await readFile(filePath)
    if (minify) {
      const result = lightningTransform({
        filename: filePath,
        code: contents,
        minify: true,
      })
      contents = result.code
    }
    // Wrap as a JS module rather than relying on rolldown's `text`
    // moduleType so the wrapping is explicit (and survives any
    // future change to rolldown's text-loader semantics).
    return {
      code: `export default ${JSON.stringify(contents.toString('utf8'))};`,
      moduleType: 'js',
    }
  },
})

// Minify the static parts of `html\`…\`` and `css\`…\`` tagged
// template literals before rolldown parses the JS source. The same
// engine the rollup-plugin-minify-html-literals-v3 plugin wraps —
// we just plug it into rolldown's transform hook. Skipped on
// node_modules (no Lit-tagged literals worth minifying live there).
// Library returns null when a file has no literals; we pass
// through unchanged in that case.
const minifyLitTemplates = {
  name: 'minify-lit-templates',
  transform: {
    filter: { id: /\.js$/ },
    handler(code, id) {
      if (id.includes('/node_modules/')) return null
      try {
        const result = minifyHTMLLiterals(code, { fileName: id })
        if (!result) return null
        return { code: result.code, map: result.map }
      } catch (err) {
        this.warn(`minify-html-literals skipped: ${err.message}`)
        return null
      }
    },
  },
}

// Map ui/<name>.<ext> → { <name>: 'ui/<name>.<ext>' } for the
// requested extension. Used to build the rolldown `input` map.
async function listEntries(extension) {
  const files = await readdir('ui')
  const entries = {}
  for (const f of files) {
    if (!f.endsWith(`.${extension}`)) continue
    entries[basename(f, `.${extension}`)] = `ui/${f}`
  }
  return entries
}

async function bundleCss(srcPath, outPath, { minify }) {
  const result = lightningBundle({ filename: srcPath, minify })
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, result.code)
}

async function bundleCssAll(outdir, { minify }) {
  const entries = await listEntries('css')
  await Promise.all(
    Object.entries(entries).map(([name, src]) =>
      bundleCss(src, joinPath(outdir, `${name}.css`), { minify })
    )
  )
}

// HTML / SVG / webmanifest assets are static; the esbuild build
// used the `copy` loader for the same effect. We just copy them
// directly with the rest of the build.
async function copyStaticAssets(outdir) {
  await mkdir(outdir, { recursive: true })
  const files = await readdir('ui')
  await Promise.all(
    files
      .filter((f) => /\.(html|svg|webmanifest)$/.test(f))
      .map((f) => copyFile(`ui/${f}`, joinPath(outdir, f)))
  )
}

const mode = process.argv[2] ?? 'build'
if (mode === 'build') {
  const outdir = 'out'
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })

  const jsEntries = await listEntries('js')
  await rolldownBuild({
    input: jsEntries,
    plugins: [minifyLitTemplates, litCssAsText({ minify: true })],
    output: {
      dir: outdir,
      // ESM output so the brotli-fallback entry's `export
      // brotliDecompress` survives the bundle and the runtime
      // `await import('./brotli-fallback.js')` from view.js gets a
      // real module namespace. index.html already loads view.js
      // with `type="module"`, so ESM is expected on the page side too.
      format: 'esm',
      minify: true,
      entryFileNames: '[name].js',
    },
  })

  await bundleCssAll(outdir, { minify: true })
  await copyStaticAssets(outdir)
} else if (mode === 'serve') {
  // Output to a session-scoped tmp dir rather than overlaying the
  // source tree (esbuild's serve trick was to write to memory and
  // overlay servedir — rolldown writes to disk, so we use a
  // separate dir and have the proxy below merge it with ui/ at
  // request time).
  const outdir = '.serve-tmp'
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir, { recursive: true })

  // Bundle CSS + copy static assets once up-front so the first
  // request from the browser doesn't 404 while rolldown is still
  // doing its initial js build.
  await copyStaticAssets(outdir)
  await bundleCssAll(outdir, { minify: false })

  const jsEntries = await listEntries('js')
  const watcher = rolldownWatch({
    input: jsEntries,
    plugins: [litCssAsText()],
    output: {
      dir: outdir,
      format: 'esm',
      entryFileNames: '[name].js',
    },
  })
  watcher.on('event', (e) => {
    if (e.code === 'BUNDLE_END') {
      console.log(`rolldown: rebuilt in ${e.duration}ms`)
      e.result.close().catch(() => {})
    } else if (e.code === 'ERROR') {
      console.error('rolldown error:', e.error.message)
      e.result?.close().catch(() => {})
    }
  })

  // CSS + static assets aren't watched by rolldown (they don't go
  // through the JS module graph), so wire up an `fs.watch` over
  // ui/ and rerun the relevant step on change. Coarse but cheap —
  // lightningcss bundles all of view.css in a few ms.
  fsWatch('ui', { recursive: true }, (event, filename) => {
    if (!filename) return
    if (filename.endsWith('.css')) {
      bundleCssAll(outdir, { minify: false }).catch((err) => {
        console.error('css rebuild:', err.message)
      })
    } else if (/\.(html|svg|webmanifest)$/.test(filename)) {
      copyStaticAssets(outdir).catch((err) => {
        console.error('asset copy:', err.message)
      })
    }
  })

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

  // Try the built output first, then fall back to ui/ source files
  // (HTML and other static assets unchanged from disk). Returns the
  // absolute path of the file to serve, or null if not found.
  async function resolveStatic(urlPath) {
    let p = urlPath
    if (p.endsWith('/')) p += 'index.html'
    p = p.replace(/^\/+/, '')
    for (const root of [outdir, 'ui']) {
      const fp = joinPath(root, p)
      try {
        const s = await stat(fp)
        if (s.isFile()) return fp
      } catch {}
    }
    return null
  }

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
    '.json': 'application/json',
    '.map': 'application/json',
  }

  const proxy = createServer(async (req, res) => {
    if (isApi(req.url)) {
      const upstream = httpRequest(
        {
          host: backendHost,
          port: backendPort,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
          upstreamRes.pipe(res)
        }
      )
      upstream.on('error', (err) => {
        // Backend down is the common case during dev (operator hasn't
        // started `node server/index.ts` yet); emit a readable 502 so
        // the browser console shows the cause instead of a generic
        // connection reset.
        const body = `Dev proxy: backend (${backendHost}:${backendPort}) unreachable — ${err.message}\n`
        if (res.headersSent) {
          res.destroy()
          return
        }
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(body)
      })
      req.on('error', () => upstream.destroy())
      req.pipe(upstream)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const file = await resolveStatic(url.pathname)
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end(`Not found: ${url.pathname}\n`)
        return
      }
      const ct = MIME[extname(file)] ?? 'application/octet-stream'
      res.writeHead(200, { 'content-type': ct })
      createReadStream(file).pipe(res)
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(`${err.message}\n`)
      } else {
        res.destroy()
      }
    }
  })

  // WS upgrade proxy: replay the request line + raw headers onto a raw
  // TCP socket to the backend, then bidirectionally pipe. `http.request`
  // does have an `upgrade` event, but its handling of the 101 response
  // is more brittle (header casing, trailing data) than a straight
  // socket forward — and the backend already speaks HTTP/1.1 upgrades
  // natively via `ws`. Any non-/api/ upgrade is unexpected and dropped.
  proxy.on('upgrade', (req, clientSocket, head) => {
    if (!isApi(req.url)) {
      clientSocket.destroy()
      return
    }
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
    console.log(`dev proxy: http://${proxyHost}:${proxyPort} → ${outdir}/ + ui/, /api/* → ${backendHost}:${backendPort}`)
  })
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(1)
}
