// What risk tells of a dependency a version adds, by its package: its tier by
// its downloads, its latest two weeks' left out (downloads.js
// npmSettledDownloads), as a package a release just pulled in, as a
// compromised one depending on it would, could owe those to that release
// alone; and below the top 20,000, how old the package was where it didn't
// exist when the version compared with was published, as plain-crypto-js
// was eighteen hours old when axios 1.14.1 was published depending on it.
import { npmDownloadTier, npmSettledDownloads, npmTierLow } from './downloads.js'

// A dependency added, from its package's facts so far: `downloads`, npm's
// count of them (null where npm counts none, as it counts none of a package's
// until the day after it was first published, nor any of a private one's);
// `listed`, once its version list is read, `{ created, private }`, when its
// first version was published and whether only a token reads it; and
// `published`, when the version compared with and the open one were. Its
// `tier` (Infinity, unpopular, where npm counts none of a public package's;
// null where it can't yet be told), whether its version list is `wanted` to
// tell more (below the top 20,000, or none counted), and `created`, `gap`
// where its package is new since the version compared with: when its first
// version was published, and how long before the open version that was
// (negative for after, as a name someone took once a release named it).
export function npmAddedDependency({ downloads, listed = null, published = [] }, now = Date.now()) {
  const settled = npmSettledDownloads(downloads, now)
  const counted = settled ? npmDownloadTier(settled) : null
  const wanted = !settled || (counted !== null && npmTierLow(counted))
  const tier = settled ? counted : listed && !listed.private ? Infinity : null
  const [was, open] = published
  const created = wanted && tier !== null && listed?.created && was && open && Date.parse(listed.created) > Date.parse(was) ? listed.created : null
  return { tier, wanted, created, gap: created ? Date.parse(open) - Date.parse(created) : null }
}
