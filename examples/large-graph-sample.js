// Deterministic synthetic Stasis bundle, sized to exercise the matrix prototype.
// node examples/large-graph-sample.js /tmp/dense-code-matrix.stasis.code.br
import { Bundle } from '@exodus/stasis-core/bundle'
import { writeFileSync } from 'node:fs'
import { brotliCompressSync } from 'node:zlib'

export function makeLargeGraph({ fileCount = 26423, packageCount = 1016, edgeCount = 66321, layerCount = 8 } = {}) {
  if (layerCount < 2 || packageCount < layerCount + 4 || fileCount < packageCount * 2) throw new Error('Need at least two files per package and enough packages for the levels and hubs')
  let seed = 0x51a715
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32 }
  const pick = (items) => items[Math.floor(random() * items.length)]
  const domains = ['auth', 'billing', 'catalog', 'checkout', 'content', 'data', 'editor', 'events', 'files', 'http', 'identity', 'metrics', 'routing', 'search', 'storage', 'ui']
  const packages = Array.from({ length: packageCount }, (_, i) => i === 0 ? '__own__'
    : i < 5 ? ['shared-types', 'logging', 'validation', 'runtime'][i - 1]
      : `@${domains[Math.floor((i - 5) / 64) % domains.length]}/${['core', 'client', 'schema', 'adapter', 'utils', 'worker', 'cache', 'transport'][i % 8]}-${String(i).padStart(4, '0')}`)
  // Broad, shallow architecture. Every package gets a parent exactly one level
  // above it. Other links cannot skip forward, so these are shortest-path levels.
  const levels = Array.from({ length: layerCount }, () => []), depth = new Map([[0, 0]])
  levels[0].push(0)
  const assign = (p, level) => { levels[level].push(p); depth.set(p, level) }
  for (let p = 1; p < 5; p++) assign(p, Math.min(p, layerCount - 1))
  const shuffled = Array.from({ length: packageCount - 5 }, (_, i) => i + 5)
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]] }
  for (let level = 1; level < layerCount; level++) assign(shuffled.pop(), level)
  const weights = levels.slice(1).map((_, i) => .12 + Math.sin((i + 1) / layerCount * Math.PI) ** 2)
  const weightSum = weights.reduce((a, b) => a + b, 0)
  for (const p of shuffled) {
    let choice = random() * weightSum, level = 1
    while (level < layerCount - 1 && choice >= weights[level - 1]) choice -= weights[level++ - 1]
    assign(p, level)
  }
  for (const level of levels) level.sort((a, b) => a - b)
  // Own source is substantial, and package sizes vary instead of every package
  // containing the same number of files.
  const counts = packages.map(() => 2)
  counts[0] = Math.max(2, Math.min(Math.floor(fileCount * .12), fileCount - 2 * (packageCount - 1)))
  let remaining = fileCount - counts.reduce((a, b) => a + b, 0)
  const fileWeights = packages.slice(1).map(() => 1 + random() ** 3 * 7)
  const fileWeightSum = fileWeights.reduce((a, b) => a + b, 0), budget = remaining
  for (let p = 1; p < packageCount; p++) { const n = Math.floor(budget * fileWeights[p - 1] / fileWeightSum); counts[p] += n; remaining -= n }
  for (let p = 1; remaining > 0; p++, remaining--) counts[p]++
  const nodes = [], importsOf = new Map(), byPkg = new Map(packages.map((pkg) => [pkg, []])), packageIndex = new Map(packages.map((pkg, i) => [pkg, i]))
  for (let p = 0; p < packageCount; p++) {
    const pkg = packages[p]
    for (let local = 0; local < counts[p]; local++) {
      const file = pkg === '__own__' ? `app/feature-${local}.js` : `node_modules/${pkg}/${local === 0 ? 'index' : `src/module-${local}`}.js`
      const node = { file, pkg, size: 120 + nodes.length % 80, totalIssues: 0 }
      nodes.push(node); byPkg.get(pkg).push(node); importsOf.set(file, new Set())
    }
  }
  let edges = 0, cross = 0
  const add = (a, b) => {
    if (a.file === b.file || importsOf.get(a.file).has(b.file)) return
    importsOf.get(a.file).add(b.file); edges++; if (a.pkg !== b.pkg) cross++
  }
  const members = (p) => byPkg.get(packages[p])
  // Keep all files reachable from their package entry, without a long file chain.
  for (const group of byPkg.values()) for (let i = 1; i < group.length; i++) add(group[Math.floor((i - 1) / 6)], group[i])
  for (let level = 1; level < layerCount; level++) {
    const parents = levels[level - 1].filter((p) => p === 0 || p >= 5)
    for (const p of levels[level]) add(pick(members(pick(parents))), members(p)[0])
    // A local cycle in each broad level, not one giant cycle through the app.
    const candidates = levels[level].filter((p) => p >= 5)
    // Spread cycles throughout the package names. Keep each triple consecutive
    // so forward peer links do not turn its entire intervening range into an SCC.
    const cycleStart = (level * 137) % Math.max(1, candidates.length - 2)
    const cycle = candidates.slice(cycleStart, cycleStart + 3)
    if (cycle.length === 3) for (let i = 0; i < 3; i++) add(members(cycle[i])[0], members(cycle[(i + 1) % 3])[0])
  }
  // Match the supplied large case's intra/cross ratio. Cross-package imports
  // spread across wide levels, with shared sink packages and same-level coupling.
  const crossTarget = Math.round(edgeCount * 31111 / 66321), intraTarget = edgeCount - crossTarget
  if (cross > crossTarget || edges - cross > intraTarget) throw new Error('Import budget is too small for a connected fixture')
  const sources = nodes.filter((n) => { const p = packageIndex.get(n.pkg); return p === 0 || p >= 5 })
  const targets = new Map(packages.map((_, p) => {
    const level = depth.get(p)
    return [p, { next: levels[level + 1] ?? [], peers: levels[level].filter((q) => q > p && q >= 5),
      hubs: [1, 2, 3, 4].filter((q) => depth.get(q) <= level + 1 && q !== p) }]
  }))
  let attempts = 0
  while (cross < crossTarget) {
    if (++attempts > edgeCount * 100) throw new Error('Could not satisfy cross-package import budget')
    const source = pick(sources), options = targets.get(packageIndex.get(source.pkg)), choice = random()
    const pool = choice < .18 ? options.hubs : choice < .85 && options.next.length ? options.next : options.peers.length ? options.peers : options.hubs
    add(source, pick(members(pick(pool))))
  }
  attempts = 0
  while (edges < edgeCount) {
    if (++attempts > edgeCount * 100) throw new Error('Could not satisfy internal import budget')
    const source = pick(nodes)
    add(source, pick(byPkg.get(source.pkg)))
  }
  return { nodes, packages, byPkg, importsOf: new Map([...importsOf].map(([f, targets]) => [f, [...targets]])), nodeByFile: new Map(nodes.map((n) => [n.file, n])) }
}

if (process.argv[1]?.endsWith('/large-graph-sample.js')) {
  const graph = makeLargeGraph()
  const modules = new Map(graph.packages.map((pkg) => {
    const dir = pkg === '__own__' ? '.' : `node_modules/${pkg}`
    return [dir, { name: pkg === '__own__' ? 'sample-app' : pkg, version: '1.0.0', files: Object.fromEntries(graph.byPkg.get(pkg).map((n) => [dir === '.' ? n.file : n.file.slice(dir.length + 1), 'export const sample = true;\n' + ' '.repeat(n.size)])) }]
  }))
  const paths = graph.nodes.map((n) => n.file)
  const bundle = new Bundle({ modules, formats: new Map(paths.map((p) => [p, 'module'])),
    imports: new Map([['node,import', new Map([...graph.importsOf].map(([f, targets]) => [f, new Map(targets.map((to) => [to, to]))]))]]),
    entries: new Set([graph.nodes[0].file]), reason: { run: paths, app: graph.byPkg.get('__own__').map((n) => n.file) },
  })
  const target = process.argv[2] ?? '/tmp/dense-code-matrix.stasis.code.br'
  writeFileSync(target, brotliCompressSync(Buffer.from(bundle.serialize())))
  console.log(`${target}: ${graph.nodes.length} files, ${graph.packages.length} packages, ${[...graph.importsOf.values()].reduce((n, imps) => n + imps.length, 0)} imports`)
}
