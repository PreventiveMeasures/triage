// Presentation only: keep original values intact (URLs, numeric IDs, and
// sentinel values all have different meanings to the consumers).
export function repositoryParts(label) {
  if (/^https?:\/\//iu.test(label)) {
    try {
      const url = new URL(label)
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length >= 2) return { owner: `${url.host}/${parts[0]}`, name: parts.slice(1).join('/') }
    } catch { /* A malformed URL remains a flat, searchable label. */ }
    return { owner: null, name: label }
  }
  const match = /^([^\s/:]+)\/(.+)$/u.exec(label)
  return match ? { owner: match[1], name: match[2] } : { owner: null, name: label }
}

const searchKey = value => value.normalize('NFKC').toLocaleLowerCase()
const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
export const OTHER_REPOSITORIES = Symbol('other repositories')

export function repositoryChoices(options, query = '', organization = null, { includeSingletonOrganizations = false } = {}) {
  const entries = options.map(option => ({ ...option, ...(option.special ? { owner: null, name: option.label } : repositoryParts(option.label)) }))
  const owners = new Map()
  for (const entry of entries) {
    if (entry.owner != null) owners.set(entry.owner, (owners.get(entry.owner) ?? 0) + 1)
  }
  const minimumGroupSize = includeSingletonOrganizations ? 1 : 2
  const organizations = [...owners].filter(([, count]) => count >= minimumGroupSize)
    .toSorted(([a], [b]) => compare(a, b)).map(([name, count]) => ({ value: name, name, count }))
  const isOther = entry => (owners.get(entry.owner) ?? 0) < minimumGroupSize
  const otherCount = entries.filter(entry => !entry.special && !entry.reset && isOther(entry)).length
  if (otherCount > 0) organizations.push({ value: OTHER_REPOSITORIES, name: 'Other', count: otherCount })
  const activeOrganization = organizations.some(group => group.value === organization) ? organization : null
  const words = searchKey(query.trim()).split(/\s+/u).filter(Boolean)
  const matches = entry => words.every(word => searchKey(entry.label).includes(word))
  // "All repositories" remains available as an explicit filter reset while
  // searching. Unattached/no-repo entries participate in search normally.
  const pinned = entries.filter(entry => entry.reset || (entry.special && matches(entry)))
  const visible = entries.filter(entry => !entry.reset && !entry.special && matches(entry) && (activeOrganization == null || (activeOrganization === OTHER_REPOSITORIES ? isOther(entry) : entry.owner === activeOrganization)))
  const groups = new Map()
  for (const entry of visible) {
    // Single-repository organizations share a flat section with full names;
    // don't spend a header and a second row on every scattered repository.
    const group = (owners.get(entry.owner) ?? 0) >= minimumGroupSize ? entry.owner : null
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(entry)
  }
  const sections = [...groups].toSorted(([a], [b]) => a == null ? 1 : b == null ? -1 : compare(a, b))
    .map(([owner, items]) => ({
      label: owner ?? (organizations.some(group => group.value !== OTHER_REPOSITORIES) ? 'Other' : null),
      organization: owner != null,
      options: items.toSorted((a, b) => compare(a.label, b.label)),
    }))
  return {
    facets: organizations, activeFacet: activeOrganization, pinned, sections,
    count: visible.length + pinned.filter(entry => !entry.reset).length,
    total: entries.filter(entry => !entry.reset).length,
    showFacets: organizations.length > 1,
  }
}
