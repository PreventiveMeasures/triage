// An action's tags as versions, as actions are released: a full one for each
// release (`v4.2.1`), and a major (`v4`) or minor one (`v4.2`) its
// maintainers move to the latest release of its line. A prerelease's tag,
// and any not of numbers alone past an optional `v`, is no version.

// A tag's version, `[major, minor, patch]`, minor and patch null where the
// tag hasn't them; null for no version.
export function tagVersion(tag) {
  const m = typeof tag === 'string' ? /^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?$/u.exec(tag) : null
  return m && [Number(m[1]), m[2] === undefined ? null : Number(m[2]), m[3] === undefined ? null : Number(m[3])]
}

// A release's, of all three parts.
export const isRelease = version => version !== null && version[2] !== null

// The higher first, a part a tag hasn't below any it has.
export const byVersion = (a, b) => (b[0] - a[0]) || ((b[1] ?? -1) - (a[1] ?? -1)) || ((b[2] ?? -1) - (a[2] ?? -1))

// Whether a release (`other`) is of the line a major or minor tag
// (`version`) names: `v4` of every `4.x.y`, `v4.2` of `4.2.y`.
export const ofLine = (version, other) => isRelease(other) && other[0] === version[0] && (version[1] === null || other[1] === version[1])

// The versions of `tags` (`{ tag, oid }` each), the highest first.
export const versionsOf = tags => tags.flatMap(({ tag, oid }) => { const version = tagVersion(tag); return version ? [{ tag, oid, version }] : [] })
  .toSorted((a, b) => byVersion(a.version, b.version))

// The latest release's tag of `tags`, else the highest version's; null where
// none is one.
export function latestOf(tags) {
  const versions = versionsOf(tags)
  return (versions.find(({ version }) => isRelease(version)) ?? versions[0])?.tag ?? null
}

// The highest release of each major line, the latest line first: where a
// commit is most likely in a release's history.
export function newestOfLines(tags) {
  const seen = new Set()
  return versionsOf(tags).filter(({ version }) => isRelease(version) && !seen.has(version[0]) && seen.add(version[0]))
}
