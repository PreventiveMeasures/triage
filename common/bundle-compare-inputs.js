import { bundleFilesAsMap } from './bundle-sources.js'

// A side's files, and the named trees holding any of them, with those they hold.
function namedTrees(details) {
  const files = bundleFilesAsMap(details), trees = new Map()
  for (const [name, paths] of Object.entries(details?.bundle?.reason ?? {})) {
    const present = new Set(Array.isArray(paths) ? paths.filter(path => files.has(path)) : [])
    if (present.size > 0) trees.set(name, present)
  }
  return { stasis: details?.kind === 'stasis', files, trees }
}

// The one tree of a stasis side naming every file it has (its own selector
// hidden, as common/bundle-reasons.js hides it), where no other side names it:
// such a side is compared within that tree under any of the others' trees.
function soleTree(side, sides) {
  if (!side.stasis || side.trees.size !== 1) return null
  const [[name, paths]] = side.trees
  return paths.size === side.files.size && !sides.some(other => other !== side && other.trees.has(name)) ? name : null
}

// A side naming no tree, or one alone holding all its files.
const trivial = side => side.trees.size === 0 || (side.trees.size === 1 && [...side.trees.values()][0].size === side.files.size)

// A tree of each side the other names none of, compared with each other, as
// one scope: the same whichever side is the base, as a swap keeps it.
const PAIR = 'reasons:'
const pairScope = (first, second) => `${PAIR}${JSON.stringify([first, second].toSorted())}`
function pairOf(scope) {
  if (!scope.startsWith(PAIR)) return null
  try {
    const pair = JSON.parse(scope.slice(PAIR.length))
    return Array.isArray(pair) && pair.length === 2 && pair.every(name => typeof name === 'string') ? pair : null
  } catch { return null }
}

// Use the union of named trees. A tree absent from one stasis bundle contains
// no files there; falling back to all files would invent additions/removals.
// A bundle that names no trees (a sourcemap) is compared whole under any of
// them, as is one whose sole tree holds all its files where the other names
// none of it (soleTree), its tree left out. Where neither side is trivial and
// each names a tree the other doesn't, the trees both name are offered, and
// each of the first side's own paired with each of the second's (pairScope),
// labelled from the first to the second. Unlike a single-bundle graph, retain
// a scope that includes every file on one side.
export function bundleCompareScopes(...details) {
  const sides = details.map(namedTrees)
  if (sides.length === 2 && !sides.some(trivial)) {
    const [first, second] = sides.map(side => [...side.trees.keys()].toSorted())
    const shared = first.filter(name => second.includes(name))
    const [firstOwn, secondOwn] = [first, second].map(names => names.filter(name => !shared.includes(name)))
    if (firstOwn.length > 0 && secondOwn.length > 0) {
      return [...shared.map(name => ({ id: `reason:${name}`, label: name })),
        ...firstOwn.flatMap(from => secondOwn.map(to => ({ id: pairScope(from, to), label: `${from} → ${to}` })))]
    }
  }
  const scoped = sides.filter(side => soleTree(side, sides) === null)
  const names = new Set(scoped.flatMap(side => [...side.trees.keys()]))
  // A scope is only useful as a filter if it changes the files compared on
  // some side. Keep every scope when at least one does, otherwise hide the
  // selector, as single-bundle views do (see common/bundle-reasons.js).
  const narrows = name => scoped.some(side => side.stasis && (side.trees.get(name)?.size ?? 0) < side.files.size)
  if (![...names].some(narrows)) return []
  return [...names].toSorted().map(name => ({ id: `reason:${name}`, label: name }))
}

// Each side's scope in a comparison within `scope`: within the tree of a pair
// (pairScope) it names; a side whose sole tree holds all its files, the other
// naming none of it (soleTree), within that tree.
export function bundleCompareSideScopes(base, other, scope = '') {
  if (!scope) return ['', '']
  const pair = pairOf(scope), sides = [base, other].map(namedTrees)
  return sides.map(side => {
    const name = pair ? pair.find(tree => side.trees.has(tree)) : soleTree(side, sides)
    return name == null ? scope : `reason:${name}`
  })
}

export function bundleCompareFiles(details, scope = '') {
  const files = bundleFilesAsMap(details)
  if (!scope || details?.kind !== 'stasis') return files
  const paths = details?.bundle?.reason?.[scope.replace(/^reason:/u, '')]
  const selected = new Set(Array.isArray(paths) ? paths : [])
  return new Map([...files].filter(([path]) => selected.has(path)))
}

// A resolution's identity: its importer, specifier, conditions (import
// attributes included), and Metro platform.
export function resolutionKey(parent, specifier, conditions, platform) {
  return JSON.stringify([parent, specifier, conditions, platform])
}

// Keep the full resolution identity: collapsing to graph edges would lose
// specifier, condition/import-attribute, and Metro platform changes.
export function bundleCompareResolutions(details, scope = '') {
  const result = new Map()
  if (details?.kind !== 'stasis' || !details.bundle) return result
  const files = scope ? bundleFilesAsMap(details) : null
  const selected = scope ? bundleCompareFiles(details, scope) : null
  for (const [conditions, byParent] of details.bundle.imports) {
    for (const [parent, specifiers] of byParent) {
      for (const [specifier, resolved] of specifiers) {
        const targets = typeof resolved === 'string' ? [[null, resolved]] : resolved
        for (const [platform, target] of targets) {
          // Include imports from scoped files, plus imports into the scope
          // from uncaptured parents (e.g. an app in a dependencies-only bundle).
          if (selected && !selected.has(parent) && (files.has(parent) || !selected.has(target))) continue
          const key = resolutionKey(parent, specifier, conditions, platform)
          result.set(key, { key, parent, specifier, conditions, platform, target })
        }
      }
    }
  }
  return result
}
