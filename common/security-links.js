// Links as stampSecurityGroups reads them, shared by the managed server's
// permission filter and the view's security lens. A star per link is enough
// for transitive propagation, without a quadratic expansion for large links.
// `add` extends the lookup while a stamp is running: rows the finding index
// returns can carry links of their own.
export function securityLinks(links = []) {
  const edges = new Map()
  const connect = (a, b) => {
    if (!edges.has(a)) edges.set(a, new Set())
    edges.get(a).add(b)
  }
  const add = (ids) => {
    for (const id of ids.slice(1)) { connect(ids[0], id); connect(id, ids[0]) }
  }
  for (const ids of links) add(ids)
  return { add, linkedIds: (id) => edges.get(id) ?? [] }
}

// An App finding can name the source findings it revalidated only by ID, in
// another row or report. The App view counts those as represented by it, so
// they are one issue for security too: hiding one side alone would leave the
// App answer to a hidden security finding, or a source row without its App row.
export function revalidationLinks(findings) {
  const links = []
  for (const finding of findings) {
    const inputs = finding?.revalidateInputs
    if (typeof finding?.id !== 'string' || !Array.isArray(inputs)) continue
    links.push([finding.id, ...inputs.filter((id) => typeof id === 'string' && id !== '')])
  }
  return links
}
