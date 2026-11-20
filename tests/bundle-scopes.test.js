import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleScopeOptions, bundleScopes, entryScope, reasonScope, scopeParts } from '../common/bundle-reasons.js'
import { templateText } from './_lit.js'

const FILES = ['src/a.js', 'src/b.js', 'src/cli.js', 'src/shared.js', 'src/only-a.js', 'src/loose.js']

// `imports` as `{ parent: [targets] }`, each target under a specifier of its own.
function details({ entries = [], reason, imports = {} } = {}) {
  const byParent = new Map(Object.entries(imports).map(([parent, targets]) => [parent, new Map(targets.map((target, i) => [`./${i}`, target]))]))
  return { kind: 'stasis', bundle: { entries: new Set(entries), reason, imports: new Map([['default', byParent]]) } }
}
const bundleEntryPoints = (bundle, paths) => bundleScopes(bundle, paths).entries

test('entry points are offered only where some reason records more than one of them', () => {
  const entries = ['src/b.js', 'src/a.js', 'src/cli.js']
  const offered = reason => bundleEntryPoints(details({ entries, reason }), FILES)
  assert.deepEqual(offered({ bundle: ['src/a.js', 'src/b.js', 'src/shared.js'], run: ['src/cli.js'] }), ['src/a.js', 'src/b.js', 'src/cli.js'],
    'two of them in `bundle`: every entry point is offered, sorted')
  assert.deepEqual(offered({ bundle: ['src/a.js', 'src/shared.js'], metro: ['src/b.js'], run: ['src/cli.js'] }), [], 'one each: a reason already is its entry point')
  assert.deepEqual(offered({ bundle: ['src/a.js', 'src/a.js', 'src/shared.js'], run: ['src/cli.js'] }), [], 'an entry point listed twice is one')
  assert.deepEqual(offered({ bundle: ['src/a.js', 'src/absent.js'], run: ['src/cli.js'] }), [], 'a file that is no entry point is not counted')
  assert.deepEqual(offered({ bundle: ['src/a.js', 'src/b.js', 'src/cli.js', ...FILES] }), ['src/a.js', 'src/b.js', 'src/cli.js'],
    'a reason holding every file is hidden as a filter, and still one holding several entry points')
})

test('a bundle recording no reasons counts as one, and only bundled entry files are entry points', () => {
  assert.deepEqual(bundleEntryPoints(details({ entries: ['src/a.js', 'src/b.js'] }), FILES), ['src/a.js', 'src/b.js'])
  assert.deepEqual(bundleEntryPoints(details({ entries: ['src/a.js', 'src/b.js'], reason: { broken: 'src/a.js' } }), FILES), ['src/a.js', 'src/b.js'], 'a malformed reason is none')
  assert.deepEqual(bundleEntryPoints(details({ entries: ['src/a.js'] }), FILES), [], 'one entry point is every file')
  assert.deepEqual(bundleEntryPoints(details({ entries: ['src/a.js', 'src/absent.js'] }), FILES), [], 'an entry file the bundle doesn\'t hold is none to filter by')
  assert.deepEqual(bundleEntryPoints(details(), FILES), [])
  assert.deepEqual(bundleEntryPoints({ kind: 'sourcemap' }, FILES), [])
  assert.deepEqual(bundleEntryPoints(null, FILES), [])
})

test('an entry point\'s files are those it reaches through the recorded imports, itself among them', () => {
  const scopes = bundleScopes(details({
    entries: ['src/a.js', 'src/b.js'],
    reason: { bundle: ['src/a.js', 'src/b.js', 'src/shared.js', 'src/only-a.js'], run: ['src/cli.js'] },
    // A cycle, and a file the bundle doesn't hold that still names what it imports.
    imports: { 'src/a.js': ['src/only-a.js', 'src/outside.js'], 'src/only-a.js': ['src/a.js'], 'src/outside.js': ['src/shared.js'], 'src/b.js': ['src/shared.js'] },
  }), FILES)
  assert.deepEqual(scopes.entries, ['src/a.js', 'src/b.js'])
  assert.deepEqual([...scopes.reasons.keys()], ['bundle', 'run'])
  assert.deepEqual(scopes.ids, ['reason:bundle', 'reason:run', 'entry:src/a.js', 'entry:src/b.js'])
  assert.deepEqual([...scopes.files('entry:src/a.js')].toSorted(), ['src/a.js', 'src/only-a.js', 'src/shared.js'])
  assert.deepEqual([...scopes.files('entry:src/b.js')].toSorted(), ['src/b.js', 'src/shared.js'])
  assert.deepEqual([...scopes.files('reason:run')], ['src/cli.js'])
  for (const id of ['', 'all', 'entry:src/cli.js', 'entry:src/shared.js', 'entry:', 'reason:missing', 'src/a.js', null, undefined, 1]) {
    assert.equal(scopes.has(id), false, `${id} is no scope`)
    assert.equal(scopes.files(id), null, `${id} filters nothing`)
  }
  assert.equal(scopes.has('entry:src/a.js'), true)
  assert.equal(scopes.has('reason:bundle'), true)
})

test('scopes read a parsed Stasis bundle, its metadata the same, and every platform of a resolution', () => {
  const bundle = Bundle.parse(new Bundle({
    modules: new Map([
      ['.', { name: 'app', version: '1.0.0', files: { 'ios.js': '1', 'web.js': '2', 'shared.js': '3' } }],
      ['node_modules/dep', { name: 'dep', version: '1.0.0', files: { 'index.js': '4', 'native.js': '5' } }],
    ]),
    entries: new Set(['ios.js', 'web.js']),
    imports: new Map([['default', new Map([
      ['ios.js', new Map([['./shared', 'shared.js'], ['dep', new Map([['ios', 'node_modules/dep/native.js'], ['android', 'node_modules/dep/index.js']])]])],
      ['web.js', new Map([['./shared', 'shared.js']])],
    ])]]),
  }).serialize())
  const scopes = bundleScopes({ kind: 'stasis', bundle })
  assert.deepEqual(scopes.entries, ['ios.js', 'web.js'])
  assert.equal(scopes.reasons.size, 0)
  assert.deepEqual([...scopes.files('entry:ios.js')].toSorted(), ['ios.js', 'node_modules/dep/index.js', 'node_modules/dep/native.js', 'shared.js'])
  assert.deepEqual([...scopes.files('entry:web.js')].toSorted(), ['shared.js', 'web.js'])
  assert.deepEqual(bundleScopes({ kind: 'stasis' }).ids, [], 'a bundle known by its identity alone has no scopes')
  assert.deepEqual(bundleScopes({ kind: 'stasis', bundle: { modules: new Map() } }).ids, [], 'nor one recording nothing to scope by, its files not read')
})

test('a scope id names a reason or an entry point, and nothing else is one', () => {
  assert.deepEqual([reasonScope('run'), entryScope('src/a.js')], ['reason:run', 'entry:src/a.js'])
  assert.deepEqual(scopeParts('reason:run'), { reason: 'run' })
  assert.deepEqual(scopeParts('entry:src/reason:a.js'), { entry: 'src/reason:a.js' })
  for (const id of ['', 'all', 'run', 'reasons:a|b', null, undefined, 1]) assert.deepEqual(scopeParts(id), {})
})

test('scope options name a reason by itself and an entry point by its path, less the directories they share', () => {
  const options = entries => bundleScopeOptions({ reasons: new Map([['run', new Set()]]), entries }).entries
  assert.deepEqual(bundleScopeOptions({ reasons: new Map([['run', new Set()]]), entries: [] }), { reasons: [{ id: 'reason:run', label: 'run' }], entries: [] })
  assert.deepEqual(options(['apps/web/src/index.js', 'apps/web/src/worker.js']), [
    { id: 'entry:apps/web/src/index.js', label: 'index.js' }, { id: 'entry:apps/web/src/worker.js', label: 'worker.js' },
  ])
  assert.deepEqual(options(['apps/a/index.js', 'apps/b/index.js']).map(option => option.label), ['a/index.js', 'b/index.js'])
  assert.deepEqual(options(['index.js', 'src/worker.js']).map(option => option.label), ['index.js', 'src/worker.js'])
  assert.deepEqual(options(['node_modules/@org/a/index.js', 'node_modules/@org/b/index.js']).map(option => option.label),
    ['node_modules/@org/a/index.js', 'node_modules/@org/b/index.js'], 'a package keeps its scope and its node_modules')
  assert.deepEqual(options(['src/a', 'src/a/b.js']).map(option => option.label), ['a', 'a/b.js'], 'a file is never cut to nothing')
})

test('the scope selector offers entry points beside reasons, one of either chosen at a time', async () => {
  await import('../ui/view/bundle-scope-selector.js')
  const Selector = customElements.get('bundle-scope-selector')
  const render = props => templateText(Object.assign(new Selector(), props).render())
  const entries = [{ id: 'entry:src/a.js', label: 'a.js' }, { id: 'entry:src/b.js', label: 'b.js' }]
  const known = [{ id: 'reason:metro', label: 'metro' }, { id: 'reason:run', label: 'run' }]
  const checked = markup => [...markup.matchAll(/<input type="radio" name="scope" value=([^\s>]*) \.checked=(true|false)/gu)].filter(match => match[2] === 'true').map(match => match[1])
  // The options each select offers, and the values of those chosen: an option says so itself.
  const selects = markup => [...markup.matchAll(/<select.*?<\/select>/gsu)].map(([select]) => {
    const options = [...select.matchAll(/<option value=("")?(\S*?) \.selected=(true|false)>([^<]*)</gu)]
    return { selected: options.filter(option => option[3] === 'true').map(option => option[2]), labels: options.map(option => option[4]) }
  })

  const toggle = render({ reasons: known, entries, value: 'reason:run' })
  assert.deepEqual(checked(toggle), ['reason:run'])
  assert.deepEqual(selects(toggle), [{ selected: [''], labels: ['Any entry point', 'a.js', 'b.js'] }], 'no entry point chosen beside a reason')
  assert.match(toggle, /<select class="scope-entry" aria-label="Entry point"/u)
  assert.match(toggle, /Node\.js CLI/u)

  const entry = render({ reasons: known, entries, value: 'entry:src/b.js' })
  assert.deepEqual(checked(entry), [], 'an entry point chosen leaves every reason, and All files, unchecked')
  assert.deepEqual(selects(entry), [{ selected: ['entry:src/b.js'], labels: ['Any entry point', 'a.js', 'b.js'] }])
  assert.doesNotMatch(entry, /<select[^>]*\.value=/u, 'chosen by its option alone: a select just created has no options yet to take a value by')
  assert.match(entry, /Files this entry point imports/u)
  const gone = render({ reasons: known, entries, value: 'entry:src/gone.js' })
  assert.deepEqual([checked(gone), selects(gone)[0].selected], [[''], ['']], 'an entry point it has none of is All files')
  assert.doesNotMatch(render({ reasons: known, value: 'reason:run' }), /<select/u, 'no entry points: the toggle alone, as before')

  const custom = render({ reasons: [{ id: 'reason:mine', label: 'mine' }], entries, value: 'entry:src/a.js' })
  assert.deepEqual(selects(custom), [{ selected: ['entry:src/a.js'], labels: ['All files', 'mine', 'a.js', 'b.js'] }])
  assert.match(custom, /<span>Scope<\/span><select aria-label=Choose scope/u)
  assert.match(custom, /<optgroup label=Reason><option value=reason:mine .*?<\/optgroup><optgroup label=Entry point><option value=entry:src\/a\.js /u)
  const reasonsOnly = render({ reasons: [{ id: 'reason:mine', label: 'mine' }], value: 'reason:mine' })
  assert.doesNotMatch(reasonsOnly, /<optgroup/u, 'reasons alone stay an ungrouped list')
  assert.deepEqual(selects(reasonsOnly), [{ selected: ['reason:mine'], labels: ['All files', 'mine'] }])
  assert.deepEqual(selects(render({ reasons: [{ id: 'reason:mine', label: 'mine' }], value: 'reason:stale' })), [{ selected: [''], labels: ['All files', 'mine'] }],
    'a scope it has none of shows as All files')

  const alone = render({ reasons: [], entries, value: '' })
  assert.match(alone, /<span>Entry point<\/span><select aria-label=Choose scope/u)
  assert.deepEqual(selects(alone), [{ selected: [''], labels: ['All files', 'a.js', 'b.js'] }])
  assert.equal(render({ reasons: [], entries: [], value: '' }), '')
})
