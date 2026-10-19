import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { BUILD_META, buildId, stampedHtml } from '../build-id.js'

test('a build\'s id is its scripts\' and styles\' hash, whatever order they are named in', () => {
  const files = [['out/view.js', Buffer.from('a')], ['out/view.css', Buffer.from('b')]]
  const id = buildId(files)
  assert.match(id, /^[a-f\d]{16}$/u)
  assert.equal(buildId(files.toReversed()), id)
  assert.notEqual(buildId([['out/view.js', Buffer.from('a')], ['out/view.css', Buffer.from('c')]]), id, 'a file changed')
  assert.notEqual(buildId([['out/view.css', Buffer.from('a')], ['out/view.js', Buffer.from('b')]]), id, 'the same bytes under other names')
})

test('a page names its build and asks for its own scripts and styles under it, its chunks and the rest as they are', async () => {
  const page = stampedHtml(await readFile('ui/index.html', 'utf8'), '0123456789abcdef')
  assert.match(page, new RegExp(`<meta charset="utf-8">\n<meta name="${BUILD_META}" content="0123456789abcdef">`, 'u'), 'after its charset')
  for (const tag of ['<link rel="preload" href="./view.css?v=0123456789abcdef" as="style" />', '<link rel="modulepreload" href="./view.js?v=0123456789abcdef" />',
    '<link href="./view.css?v=0123456789abcdef" rel="stylesheet" />', '<script src="./view.js?v=0123456789abcdef" type="module" defer></script>']) assert.ok(page.includes(tag), tag)
  assert.ok(page.includes('href="./icon.svg"') && page.includes('href="./manifest.webmanifest"'), 'what is no script or style, as it is')
  assert.equal(stampedHtml('<link rel="modulepreload" href="./chunk-ABC123.js" />', 'f'), '<link rel="modulepreload" href="./chunk-ABC123.js" />', 'a chunk, named by its content')
  assert.equal(stampedHtml('<head><script type="module" src="./page.js"></script></head>', 'f'), '<head><script type="module" src="./page.js?v=f"></script></head>', 'a page declaring no charset')
})

test('a bundle loaded at runtime is asked for under the build its page names, beside any query of its own; under none, as it is', async t => {
  const plain = await import('../ui/view/built.js?none')
  assert.equal(plain.built('./dialogs.js'), './dialogs.js', 'no page')
  assert.equal(plain.built('./dialogs.js', { retry: 1 }), './dialogs.js?retry=1')
  // A page naming a build, as build.js writes one (the tests have no document).
  globalThis.document = { querySelector: selector => selector === `meta[name="${BUILD_META}"]` ? { getAttribute: name => name === 'content' ? '0123456789abcdef' : null } : null }
  t.after(() => { delete globalThis.document })
  const named = await import('../ui/view/built.js?named')
  assert.equal(named.built('./client-managed.js'), './client-managed.js?v=0123456789abcdef')
  assert.equal(named.built('./dialogs.js', { retry: 2 }), './dialogs.js?v=0123456789abcdef&retry=2')
})
