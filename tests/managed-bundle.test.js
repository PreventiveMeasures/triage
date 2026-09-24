import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

test('Manage pages belong only to the lazy client-managed bundle, without duplicating local client state', async () => {
  const { metafile } = await build({
    entryPoints: ['ui/view.js', 'ui/client-managed.js'],
    bundle: true, format: 'esm', write: false, outdir: 'out',
    loader: { '.css': 'text' }, metafile: true,
  })
  const main = metafile.outputs['out/view.js'].inputs
  const managed = metafile.outputs['out/client-managed.js'].inputs
  assert.equal(Object.hasOwn(main, 'ui/managed/pages.js'), false)
  assert.equal(Object.hasOwn(main, 'ui/view/scan-model-picker.js'), false)
  assert.ok(managed['ui/managed/pages.js'])
  assert.ok(managed['ui/view/scan-model-picker.js'])
  assert.ok(managed['client/managed/session.js'])
  assert.deepEqual(Object.keys(managed).filter(path => path.startsWith('client/') && !path.startsWith('client/managed/')), [],
    'a shared icon must not pull local storage, state, or sync into the managed chunk')
})
