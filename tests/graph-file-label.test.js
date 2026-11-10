import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { bundlePkgOf } from '../ui/view/bundle-pkg-of.js'
import { fileLabelOf } from '../ui/view/graph/file-label.js'
import { buildSizeFlow } from '../ui/view/graph/size-flow-model.js'
import { buildDependencyMatrix } from '../ui/view/graph/matrix-model.js'
import '../ui/view/graph/size-flow.js'

const knexDir = 'node_modules/.pnpm/knex@2.5.1_pg@8.6.0_supports-color@8.1.1/node_modules/knex'
const node = (file, { packageDir = null, origFile } = {}) => ({ file, origFile, pkg: bundlePkgOf(origFile ?? file, { packageDir }) })

describe('fileLabelOf', () => {
  test("names a dependency's file by its package, however deep pnpm installs it", () => {
    assert.equal(fileLabelOf(node(`${knexDir}/lib/index.js`, { packageDir: knexDir })), 'knex/lib/index.js')
    assert.equal(fileLabelOf(node(`${knexDir}/lib/index.js`)), 'knex/lib/index.js', 'without recorded package dirs too')
    const scoped = 'node_modules/.pnpm/@babel+runtime@7.24.0/node_modules/@babel/runtime'
    assert.equal(fileLabelOf(node(`${scoped}/helpers/x.js`, { packageDir: scoped })), '@babel/runtime/helpers/x.js')
    assert.equal(fileLabelOf(node('node_modules/lodash/lodash.js', { packageDir: 'node_modules/lodash' })), 'lodash/lodash.js')
  })

  test('a nested install is named by the package that holds it', () => {
    const dir = 'node_modules/a/node_modules/b'
    assert.equal(fileLabelOf(node(`${dir}/index.js`, { packageDir: dir })), 'b/index.js')
  })

  test('a vendored package by its name, own source and workspace modules by their path', () => {
    assert.equal(fileLabelOf(node('vendor/log/src/lib.rs', { packageDir: 'vendor/log' })), 'log/src/lib.rs')
    assert.equal(fileLabelOf(node('src/index.js', { packageDir: '.' })), 'src/index.js')
    assert.equal(fileLabelOf(node('packages/app/src/x.js', { packageDir: 'packages/app' })), 'packages/app/src/x.js')
  })

  test("anchors in the original path, and keeps the graph's stripped one where no package names the file", () => {
    assert.equal(fileLabelOf({ file: 'index.js', origFile: 'node_modules/knex/index.js', pkg: 'knex' }), 'knex/index.js')
    assert.equal(fileLabelOf({ file: 'app/src/x.js', origFile: 'packages/app/src/x.js', pkg: 'packages/app' }), 'app/src/x.js')
    assert.equal(fileLabelOf({ file: 'src/x.js', origFile: 'root/src/x.js', pkg: '__own__' }), 'src/x.js')
  })
})

function pnpmGraph() {
  const files = {
    'src/index.js': { size: 10, imports: [`${knexDir}/knex.js`] },
    [`${knexDir}/knex.js`]: { size: 100, imports: [`${knexDir}/lib/index.js`] },
    [`${knexDir}/lib/index.js`]: { size: 200, imports: [] },
  }
  return {
    nodes: Object.entries(files).map(([file, { size }]) => ({
      file, size, pkg: bundlePkgOf(file, { packageDir: file.startsWith(knexDir) ? knexDir : '.' }),
      packageInfo: file.startsWith(knexDir) ? { directory: knexDir, version: '2.5.1' } : undefined,
    })),
    importsOf: new Map(Object.entries(files).map(([file, { imports }]) => [file, imports])),
    flowEntries: [{ file: 'src/index.js' }],
  }
}

test("Size flow names a dependency's file bars by package, keeping the install path", () => {
  const model = buildSizeFlow(pnpmGraph())
  const bar = model.byId.get(`f:${knexDir}/lib/index.js`)
  assert.equal(bar.label, 'knex/lib/index.js')
  assert.equal(bar.path, `${knexDir}/lib/index.js`)
  assert.equal(model.byId.get('f:src/index.js').label, 'src/index.js')
  assert.equal(buildSizeFlow(pnpmGraph(), { packages: true }).byId.get('p:knex').label, 'knex', 'package bars are unchanged')
})

test("Size flow's details name the file by package, and say which install it is", () => {
  const Flow = customElements.get('size-flow'), flow = new Flow()
  flow.graph = pnpmGraph(); flow.willUpdate(new Map([['graph', null]]))
  const text = value => Array.isArray(value) ? value.map(text).join('') : value?.strings
    ? value.strings.map((part, i) => part + text(value.values[i])).join('') : typeof value === 'string' ? value : ''
  flow.select(`f:${knexDir}/lib/index.js`)
  const panel = text(flow.renderPanel())
  assert.match(panel, /<h3>knex\/lib\/index\.js<\/h3>/u)
  assert.ok(panel.includes(`<div class="flow-versions"><div>2.5.1</div><small>${knexDir}/lib/index.js</small></div>`))
  flow.select('f:src/index.js')
  assert.doesNotMatch(text(flow.renderPanel()), /flow-versions/u, 'own source names itself by its path already')
})

test("Matrix names an expanded dependency's file rows by package", () => {
  const model = buildDependencyMatrix(pnpmGraph(), { expanded: new Set(['knex']) })
  assert.deepEqual(model.rows.filter(row => row.file).map(row => row.label).toSorted(), ['knex/knex.js', 'knex/lib/index.js'])
  const search = buildDependencyMatrix(pnpmGraph(), { expanded: new Set(['knex']), query: 'knex/lib' })
  assert.ok(search.rows.some(row => row.label === 'knex/lib/index.js'), 'search finds a row by its label')
})
