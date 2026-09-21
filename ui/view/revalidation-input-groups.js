// Recover source-level row boundaries before hiding the App layer. App
// deduplication alone does not make the underlying code findings equivalent.
// Only split when every source ID is accounted for and every referenced input
// exists in this row. Missing input lists are empty, not missing evidence for
// an otherwise complete partition. Original findings and rows stay untouched.
export function splitRevalidationInputs(group, appFindings = null) {
  const app = appFindings ?? group.filter((f) => f.isApp)
  const source = group.filter((f) => !f.isApp)
  if (app.length === 0 || source.length === 0) return [group]
  // A surviving App finding means this is not a pure non-App projection;
  // never move it into a source-only partition.
  if (appFindings && group.some((f) => f.isApp)) return [group]
  if (source.some((f) => typeof f.id !== 'string' || !f.id)) return [group]

  const sourceIds = new Set(source.map((f) => f.id))
  const inputsByApp = new Map()
  const covered = new Set()
  for (const f of app) {
    const inputs = f.revalidateInputs === undefined ? [] : f.revalidateInputs
    if (!Array.isArray(inputs)) return [group]
    for (const id of inputs) {
      if (!sourceIds.has(id)) return [group]
      covered.add(id)
    }
    inputsByApp.set(f, inputs)
  }
  if (covered.size !== sourceIds.size) return [group]

  const parent = new Map([...sourceIds].map((id) => [id, id]))
  const find = (id) => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)
    while (parent.get(id) !== root) {
      const next = parent.get(id)
      parent.set(id, root)
      id = next
    }
    return root
  }
  for (const inputs of inputsByApp.values()) {
    if (inputs.length === 0) continue
    const root = find(inputs[0])
    for (const id of inputs) parent.set(find(id), root)
  }

  const components = new Map()
  for (const f of group) {
    const inputs = inputsByApp.get(f)
    // Keep an App finding with its inputs until the caller projects the lens.
    // App findings without inputs stand alone; hiding them then drops the row.
    const key = inputs ? inputs.length > 0 ? find(inputs[0]) : f : find(f.id)
    if (!components.has(key)) components.set(key, [])
    components.get(key).push(f)
  }
  return components.size === 1 ? [group] : [...components.values()]
}
