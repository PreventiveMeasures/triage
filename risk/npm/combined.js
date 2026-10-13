// What calls for a look at a version against the one compared with, as one
// list: what it holds, always (held.js npmHeldFindings, and its dependencies
// against none, npmHeldDependencyFindings), as no change hides any of it; and
// what changed (compare.js npmCompareFindings), each change to what it holds
// folded into its held finding, never lowering it: its severity the higher of
// the two, the files, scripts or dependencies the change brought marked
// (`added`); the rest (a publisher changed, provenance lost, large code
// added, a file become unreadable, hosts named anew) as they are.
import { SEVERITIES } from '../files/stamps.js'
import { HOST_TAGS } from '../files/hosts.js'
import { npmDependencyFindings } from './compare.js'
import { npmHostFinding } from './held.js'

// A version's dependencies that call for a look whatever came before it
// (compare.js npmDependencyFindings against none, `dependencies` flagged
// against none): `held-non-registry-deps` and `held-unused-deps`.
export const npmHeldDependencyFindings = dependencies => npmDependencyFindings(dependencies, null).map(finding => ({ ...finding, id: `held-${finding.id}` }))

// The more severe of two severities (stamps.js SEVERITIES).
const higher = (a, b) => SEVERITIES[Math.min(SEVERITIES.indexOf(a), SEVERITIES.indexOf(b))]

// What a change to what a version holds marks of its held finding's rows,
// by the change's id: a file's what it runs, the services it names under a
// hosts' tag, and an obfuscator's fingerprint new to it (`added`); the
// scripts added or changed and what each version ran (`flagged`, `was`); a
// dependency taken from elsewhere than npm's registry anew, its spec before
// (`was`), or added that nothing imports (`added`). Code kept running beyond
// itself (`kept-runs-code`) marks nothing, its files held already.
const byPath = (rows, key) => new Map(rows.map(row => [row.path, row[key]]))
const marked = (held, rows) => ({ ...held, files: held.files.map(row => rows.has(row.path) ? { ...row, added: rows.get(row.path) } : row) })
const FOLDS = {
  'runs-code': ['held-runs-code', (held, change) => marked(held, byPath(change.files, 'added'))],
  'kept-runs-code': ['held-runs-code', held => held],
  obfuscated: ['held-obfuscated', (held, change) => marked(held, byPath(change.files, 'obfuscation'))],
  'install-scripts': ['held-install-scripts', (held, change) => ({ ...held, flagged: change.flagged, was: [...change.was] })],
  'non-registry-deps': ['held-non-registry-deps', (held, change) => {
    const was = new Map(change.dependencies.map(row => [row.name, row.was]))
    return { ...held, dependencies: held.dependencies.map(row => was.has(row.name) ? { ...row, was: was.get(row.name), added: true } : row) }
  }],
  'unused-deps': ['held-unused-deps', (held, change) => {
    const added = new Set(change.dependencies.map(row => `${row.kind ?? ''}\0${row.name}`))
    return { ...held, dependencies: held.dependencies.map(row => added.has(`${row.kind ?? ''}\0${row.name}`) ? { ...row, added: true } : row) }
  }],
  ...Object.fromEntries([...HOST_TAGS.keys()].map(npmHostFinding).map(id => [id, [`held-${id}`, (held, change) => marked(held, byPath(change.files, 'added'))]])),
}

// Who published the open version and how, ahead of what it holds, as a
// reviewer reads them; what else changed after it.
const FIRST = new Set(['publisher', 'provenance-lost'])

// What a version holds (`held`) with what changed against the one compared
// with (`changed`) folded in, as one list in the order a reviewer reads it: a
// publisher changed and provenance lost, what it holds, then the rest of what
// changed. A change whose held finding is missing is kept as it is.
export function npmCombinedFindings(held, changed) {
  const combined = new Map(held.map(finding => [finding.id, finding]))
  const rest = []
  for (const change of changed) {
    const [id, fold] = FOLDS[change.id] ?? []
    const into = id && combined.get(id)
    if (into) combined.set(id, { ...fold(into, change), severity: higher(into.severity, change.severity) })
    else rest.push(change)
  }
  return [...rest.filter(({ id }) => FIRST.has(id)), ...combined.values(), ...rest.filter(({ id }) => !FIRST.has(id))]
}
