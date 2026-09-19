// Identical report cards share a block and its report chips. Compare their
// complete membership, not only the ids in this link: [A,B,X] and [A,B,Y]
// must not become one row just because the link happens to name A and B.
export function groupLinkedReportRows(ids, reportRows) {
  const linked = new Set(ids), located = new Set(), variants = new Map()
  const order = new Map(ids.map((id, i) => [id, i]))
  for (const row of reportRows) {
    const allMembers = [...new Map(row.members.map((f) => [f.id, f])).values()]
    const matches = allMembers.filter((f) => linked.has(f.id))
    if (matches.length === 0) continue
    for (const f of matches) located.add(f.id)
    // Match the sidebar's producer classification: native/unknown sources
    // are DeepView. Only its revalidation pass is useful as unlinked context.
    // Both halves of that are what `isApp` says, stamped per member where the
    // index builds them (client/bundle-finding-index.js).
    const members = allMembers.filter((f) => linked.has(f.id) || f.isApp)
    // Reports can stamp the same id differently, so share report chips only
    // when both the original membership and visible member metadata agree.
    // Fixed tuples make property order irrelevant; sort by id so reordered
    // copies still share a block without borrowing another report's title.
    const key = JSON.stringify([
      allMembers.map((f) => f.id).toSorted(),
      members.map((f) => [f.id, f.title ?? '', f.source ?? null, f.revalidate ?? ''])
        .toSorted(([a], [b]) => a.localeCompare(b)),
    ])
    let variant = variants.get(key)
    if (!variant) {
      variant = { key, members, reports: [], first: Math.min(...matches.map((f) => order.get(f.id))) }
      variants.set(key, variant)
    }
    if (!variant.reports.some((r) => r.name === row.report)) {
      variant.reports.push({ name: row.report, findingId: matches[0].id, rowIndex: row.index })
    }
  }
  return {
    rows: [...variants.values()].toSorted((a, b) => a.first - b.first),
    missing: ids.filter((id) => !located.has(id)),
  }
}
