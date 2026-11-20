import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { createBundleMetadata, parseBundleMetadata } from '../common/bundle-metadata.js'
import { bundleWhy, layoutWhy } from '../ui/view/bundle-why.js'

mock.module('../ui/view/dom.js', { namedExports: { makeStackedModalError: cause => new Error('Modal conflict', { cause }) } })
mock.module('../ui/view/tooltip.js', { namedExports: { installShadowTooltipListener() {} } })
await import('../ui/view/dialogs/why-dialog.js')

function text(value) {
  if (Array.isArray(value)) return value.map(text).join('')
  if (value?.strings) return value.strings.reduce((out, part, i) => out + part + text(value.values[i]), '')
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

test('why titles and captions distinguish all-version queries from exact-version queries', () => {
  const Dialog = customElements.get('why-dialog'), dialog = new Dialog()
  dialog._current = true
  dialog.packageKey = 'dep'
  const nodes = new Map(['1.0.0', '2.0.0', '1.0.0'].map((version, i) => [String(i), { id: String(i), name: 'dep', version, target: true, root: true }]))
  const links = () => new Map([...nodes.keys()].map(id => [id, new Set()]))
  dialog.graph = { nodes, targets: [...nodes.keys()], imports: links(), importedBy: links() }
  dialog.layout = layoutWhy(dialog.graph)
  let markup = text(dialog.render())
  assert.match(markup, /<h3 id="why-title">dep<\/h3>/u)
  assert.match(markup, /3 packages · 3 installations/u)
  assert.doesNotMatch(markup, /of this version|heading-version/u)
  dialog.version = '1.0.0'
  markup = text(dialog.render())
  assert.match(markup, /<span class="heading-version">1\.0\.0<\/span>/u)
  assert.match(markup, /installations of this version/u)
  dialog.graph.targets = []
  assert.match(text(dialog.render()), /metadata for this version/u)
  dialog.version = undefined
  assert.match(text(dialog.render()), /metadata for this package/u)
})

test('intentional trace boundaries do not claim their importer metadata is missing', () => {
  const Dialog = customElements.get('why-dialog'), dialog = new Dialog()
  const node = { id: 'node_modules/@babel/core', name: '@babel/core', ecosystem: 'npm', version: '1.0.0', target: true }
  dialog.graph = { nodes: new Map([[node.id, node]]), imports: new Map([[node.id, new Set()]]), importedBy: new Map([[node.id, new Set()]]) }
  dialog.layout = layoutWhy(dialog.graph)
  for (const boundary of [false, true]) {
    node.traceBoundary = boundary
    assert.equal(text(dialog.renderGraph()).includes('Some chains have no recorded app or entry point.'), !boundary)
    const card = text(dialog.renderNode({ id: node.id, x: 0, y: 0 }, null))
    assert.equal(card.includes('Dependency tracing stops here.'), boundary)
    assert.equal(card.includes('No importer is recorded in this scope.'), !boundary)
  }
})

test('excluded discovery imports do not create false missing-origin notices', async () => {
  const Dialog = customElements.get('why-dialog')
  const executor = 'node_modules/react-native/scripts/codegen/generate-artifacts-executor.js'
  for (const [cut, cycleSize, unknown] of [[true, 0, false], [false, 0, false], [true, 2, false], [true, 12, false], [true, 0, true]]) {
    const cycle = ['node_modules/loader/index.js', ...Array.from({ length: Math.max(0, cycleSize - 2) }, (_, i) => `node_modules/helper-${i}/index.js`), executor]
    const files = [...cycle, 'node_modules/dep/index.js', ...(unknown ? ['node_modules/unknown/index.js'] : [])]
    const modules = new Map(files.map(file => {
      const dir = file === executor ? 'node_modules/react-native' : file.slice(0, -'/index.js'.length)
      return [dir, { name: dir.slice('node_modules/'.length), version: '1.0.0', files: { [file.slice(dir.length + 1)]: 'source' } }]
    }))
    modules.get('node_modules/loader').files['package.json'] = '{}'
    const imports = new Map(files.map(file => [file, new Map()]))
    imports.get(cycle[0]).set('dep', 'node_modules/dep/index.js')
    if (cut) imports.get(executor).set('discovery', 'node_modules/loader/package.json')
    if (cycleSize) for (const [i, file] of cycle.entries()) imports.get(file).set('next', cycle[(i + 1) % cycle.length])
    if (unknown) imports.get('node_modules/unknown/index.js').set('dep', 'node_modules/dep/index.js')
    const details = { kind: 'stasis', integrity: 'discovery-note', size: 1, bundle: new Bundle({ modules, imports: new Map([['node,import', imports]]) }) }
    const metadata = parseBundleMetadata(await createBundleMetadata(details), details.integrity)
    for (const input of [details, metadata]) {
      const originalImports = structuredClone(input.bundle.imports)
      const dialog = new Dialog()
      dialog.graph = bundleWhy(input, { packageKey: 'dep', version: '1.0.0' })
      dialog.layout = layoutWhy(dialog.graph)
      const expectedNotice = !cut || cycleSize > 0 || unknown
      assert.equal(text(dialog.renderGraph()).includes('Some chains have no recorded app or entry point.'), expectedNotice,
        `cut=${cut}, cycleSize=${cycleSize}, unknown=${unknown}: internal exclusions and independent unknown branches do not explain a missing origin`)
      const card = text(dialog.renderNode({ id: 'node_modules/loader', x: 0, y: 0 }, null))
      assert.equal(card.includes('No importer is recorded in this scope.'), !cut)
      assert.equal(card.includes('Dependency tracing stops here.'), cut && cycleSize === 0)
      dialog.layout = layoutWhy(dialog.graph, { expandedCycles: new Set(dialog.layout.boxes.map(box => box.id)) })
      assert.equal(text(dialog.renderGraph()).includes('Some chains have no recorded app or entry point.'), expectedNotice, 'expansion does not change the notice')
      assert.deepEqual(input.bundle.imports, originalImports, 'notice handling does not change shared import data')
    }
  }
})

test('resizing preserves the scroll position of focused cycle toggles and packages on side branches', t => {
  const globals = ['document', 'getComputedStyle', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  t.after(() => {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  let resize
  globalThis.document = { documentElement: { clientWidth: 1024 } }
  globalThis.getComputedStyle = () => ({ fontSize: '16px' })
  globalThis.ResizeObserver = class {
    constructor(callback) { resize = callback }
    observe() {}
  }
  const Dialog = customElements.get('why-dialog'), dialog = new Dialog()
  const scroller = { clientWidth: 600, scrollLeft: 0 }
  dialog.renderRoot = { activeElement: null, querySelector: selector => selector === '.graph-scroll' ? scroller : null }
  dialog.layout = { width: 2400 }
  dialog._maxWidth = Math.floor(1024 * .94)
  dialog.firstUpdated()
  for (const className of ['cycle-toggle', 'package']) {
    dialog.renderRoot.activeElement = { matches: selector => selector.split(', ').includes(`.${className}`) }
    for (const scrollLeft of [0, 1800]) {
      scroller.scrollLeft = scrollLeft
      resize()
      assert.equal(scroller.scrollLeft, scrollLeft, `${className} remains visible on either side after resize`)
    }
  }
  dialog.renderRoot.activeElement = null
  resize()
  assert.equal(scroller.scrollLeft, 900, 'unfocused graphs still center their chains')
})
