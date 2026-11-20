import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundleScopes } from '../common/bundle-reasons.js'
import { templateText } from './_lit.js'

const FILES = ['src/a.js', 'src/b.js', 'src/cli.js', 'src/shared.js', 'src/only-a.js']
// `imports` as `{ parent: [targets] }`.
function details({ entries = ['src/a.js', 'src/b.js', 'src/cli.js'], reason, imports = {} } = {}) {
  const byParent = new Map(Object.entries(imports).map(([parent, targets]) => [parent, new Map(targets.map((target, i) => [`./${i}`, target]))]))
  return { kind: 'stasis', bundle: { entries: new Set(entries), reason, imports: new Map([['default', byParent]]) } }
}
const ids = options => bundleScopes(details(options), FILES).ids

test('entry points are scopes only where some reason records more than one of them', () => {
  assert.deepEqual(ids({ reason: { bundle: ['src/a.js', 'src/b.js', 'src/shared.js'], run: ['src/cli.js'] } }),
    ['reason:bundle', 'reason:run', 'entry:src/a.js', 'entry:src/b.js', 'entry:src/cli.js'])
  assert.deepEqual(ids({ reason: { bundle: ['src/a.js', 'src/a.js', 'src/shared.js'], metro: ['src/b.js'], run: ['src/cli.js'] } }),
    ['reason:bundle', 'reason:metro', 'reason:run'], 'one each, listed twice or not: a reason already is its entry point')
  assert.deepEqual(ids({ reason: { bundle: FILES } }), ['entry:src/a.js', 'entry:src/b.js', 'entry:src/cli.js'], 'a reason of every file is no filter, and still holds several')
  assert.deepEqual(ids(), ['entry:src/a.js', 'entry:src/b.js', 'entry:src/cli.js'], 'a bundle recording no reasons counts as one')
  assert.deepEqual(ids({ entries: ['src/a.js', 'src/absent.js'] }), [], 'an entry point the bundle holds no file of is none')
  assert.deepEqual(bundleScopes({ kind: 'sourcemap' }, FILES).ids, [])
})

test('an entry point\'s files are those it reaches through the recorded imports', () => {
  const scopes = bundleScopes(details({ reason: { bundle: ['src/a.js', 'src/b.js'], run: ['src/cli.js'] },
    // A cycle, and a file the bundle doesn't hold that still names what it imports.
    imports: { 'src/a.js': ['src/only-a.js', 'src/outside.js'], 'src/only-a.js': ['src/a.js'], 'src/outside.js': ['src/shared.js'], 'src/b.js': ['src/shared.js'] } }), FILES)
  assert.deepEqual([...scopes.files('entry:src/a.js')], ['src/a.js', 'src/only-a.js', 'src/shared.js'])
  assert.deepEqual([...scopes.files('entry:src/b.js')], ['src/b.js', 'src/shared.js'])
  assert.deepEqual([...scopes.files('reason:run')], ['src/cli.js'])
  assert.deepEqual([...scopes.files('entry:src/cli.js')], ['src/cli.js'])
  for (const id of ['', 'entry:src/shared.js', 'reason:missing', 'run']) assert.deepEqual([scopes.has(id), scopes.files(id)], [false, null])
})

test('the scope selector lists entry points apart from reasons, one of either chosen', async () => {
  await import('../ui/view/bundle-scope-selector.js')
  const render = (reasons, value) => templateText(Object.assign(new (customElements.get('bundle-scope-selector'))(), { reasons, value }).render())
  const chosen = markup => [...markup.matchAll(/value=(\S*) \.(?:checked|selected)=true/gu)].map(match => match[1])
  const entries = [{ id: 'entry:src/a.js', label: 'src/a.js' }, { id: 'entry:src/b.js', label: 'src/b.js' }]
  const known = [{ id: 'reason:metro', label: 'metro' }, { id: 'reason:run', label: 'run' }, ...entries]
  assert.deepEqual(chosen(render(known, 'reason:run')), ['reason:run', '""'], 'a reason, and no entry point')
  assert.deepEqual(chosen(render(known, 'entry:src/b.js')), ['entry:src/b.js'], 'an entry point leaves every reason, and All files, unchecked')
  assert.match(render(known, ''), /<select class="scope-entry".*Any entry point<\/option><option value=entry:src\/a\.js [^>]*>src\/a\.js</u)
  const custom = render([{ id: 'reason:mine', label: 'mine' }, ...entries], 'entry:src/a.js')
  assert.match(custom, /<option value=reason:mine [^>]*>mine<\/option><optgroup label="Entry point"><option value=entry:src\/a\.js \.selected=true>/u)
  assert.deepEqual(chosen(render(entries, 'reason:gone')), ['""'], 'a scope it has none of is All files')
})
