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

const mode = process.argv[2] ?? 'build'
if (mode === 'build') {
  await esbuild.build({
    bundle: true,
    plugins: [litCssAsText({ minify: true })],
    entryPoints: ['ui/*.js', 'ui/*.css', 'ui/*.html'],
    loader: { '.html': 'copy' },
    outdir: 'out',
    minify: true,
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
  })
  await ctx.serve({ host: '127.0.0.1', port: 8000, servedir: 'ui' })
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(1)
}
