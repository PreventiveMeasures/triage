import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'
import { litSvgAsHtml } from '../build-lit-svg.js'

test('SVG imports are Lit html templates while SVG entry points remain assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lit-svg-'))
  try {
    // Preserve literal template syntax in resource text; it must never become
    // JavaScript interpolation when the bundler wraps the SVG in html`…`.
    const svg = '<svg viewBox="0 0 24 24"><title>`mark` ${literal} \\</title><path fill="currentColor" d="M0 0h24v24H0Z"/></svg>'
    await writeFile(join(dir, 'mark.svg'), svg)
    await writeFile(join(dir, 'entry.js'), "export { default } from './mark.svg'\n")
    for (const minify of [false, true]) {
      const { outputFiles } = await build({
        entryPoints: [join(dir, 'entry.js'), join(dir, 'mark.svg')],
        bundle: true, format: 'esm', platform: 'node', minify, write: false,
        outdir: join(dir, 'out'), nodePaths: [resolve('node_modules')],
        loader: { '.svg': 'copy' }, plugins: [litSvgAsHtml],
      })
      const js = outputFiles.find(file => file.path.endsWith('/entry.js'))
      const { default: template } = await import(`data:text/javascript,${encodeURIComponent(js.text)}`)
      assert.equal(template._$litType$, 1)
      assert.deepEqual([...template.strings], [svg])
      assert.deepEqual(template.values, [])
      assert.equal(outputFiles.find(file => file.path.endsWith('/mark.svg')).text, svg)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('provider icons are embedded as templates without external SVG outputs', async () => {
  const { outputFiles } = await build({
    entryPoints: ['ui/view/provider-icons.js'], bundle: true, format: 'esm',
    platform: 'node', write: false, plugins: [litSvgAsHtml],
  })
  assert.equal(outputFiles.length, 1)
  const { providerIcon } = await import(`data:text/javascript,${encodeURIComponent(outputFiles[0].text)}`)
  for (const [key, name] of Object.entries({ anthropic: 'claude', openai: 'openai', moonshot: 'moonshot', google: 'google', openrouter: 'openrouter', deepseek: 'deepseek', nvidia: 'nvidia', qwen: 'qwen', 'x-ai': 'grok', 'z-ai': 'zai' })) {
    const icon = providerIcon(key)
    assert.equal(icon._$litType$, 1)
    assert.equal(icon.strings[0], await readFile(`ui/provider-icons/${name}.svg`, 'utf8'))
  }
  assert.equal(providerIcon('moonshot'), providerIcon('moonshotai'))
  assert.equal(providerIcon('unknown')._$litType$, 1)
  assert.equal(providerIcon('__proto__'), providerIcon('unknown'))
})
