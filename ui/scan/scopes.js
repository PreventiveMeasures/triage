// Each runtime one beside what a static build names it (bundle:metro, bundle), and extra beside add.
const KNOWN_SCOPES = [
  { key: 'metro', label: 'metro', subtitle: 'Metro bundle contents' },
  { key: 'bundle:metro', label: 'bundle:metro', subtitle: 'Metro bundle contents (static)' },
  { key: 'run', label: 'run', subtitle: 'Node.js CLI' },
  { key: 'bundle', label: 'bundle', subtitle: 'Static code bundle' },
  { key: 'add', label: 'add', subtitle: 'Manually added files' },
  { key: 'extra', label: 'extra', subtitle: 'Extra files' },
]

// Keep actual scope IDs and show only scopes present in the bundle. A custom
// scope must remain accessible through the dropdown rather than being lost.
export function scanScopeOptions(reasons) {
  const named = reasons.filter(reason => reason.id !== 'all')
  if (named.length === 0) return null
  const byKey = new Map(named.map(reason => [String(reason.id).replace(/^reason:/u, ''), reason]))
  if (byKey.size !== named.length || [...byKey.keys()].some(key => !KNOWN_SCOPES.some(scope => scope.key === key))) return null
  return [{ id: '', label: 'All files', subtitle: 'Everything' },
    ...KNOWN_SCOPES.filter(scope => byKey.has(scope.key)).map(({ key, ...scope }) => ({ ...scope, id: byKey.get(key).id,
      subtitle: key === 'run' && byKey.has('metro') ? 'Bundler and Node.js CLI' : scope.subtitle }))]
}
