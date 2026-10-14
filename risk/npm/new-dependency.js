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
// `published`, when the version compared with and the open one were; and
// whether nothing of the version imports it (`unused`). Its `tier`
// (Infinity, unpopular, where npm counts none of a public package's; null
// where it can't yet be told), whether its version list is `wanted` to tell
// more (below the top 20,000, or none counted, or unused whatever its tier,
// as how new its package is grades it, npmUnusedDependencySeverity), and
// `created`, `gap`
// where its package is new since the version compared with: when its first
// version was published, and how long before the open version that was
// (negative for after, as a name someone took once a release named it).
export function npmAddedDependency({ downloads, listed = null, published = [], unused = false }, now = Date.now()) {
  const settled = npmSettledDownloads(downloads, now)
  const counted = settled ? npmDownloadTier(settled) : null
  const wanted = !settled || unused || (counted !== null && npmTierLow(counted))
  const tier = settled ? counted : listed && !listed.private ? Infinity : null
  const [was, open] = published
  const created = wanted && tier !== null && listed?.created && was && open && Date.parse(listed.created) > Date.parse(was) ? listed.created : null
  return { tier, wanted, created, gap: created ? Date.parse(open) - Date.parse(created) : null }
}

// What a dependency nothing of a version imports calls for (compare.js
// `unused-deps`), by what risk tells of its package (`told`, its row as
// assess.js addedDependencies tells it, or none): one kept from the version
// compared with (`kept`) yellow, as that version, risk's pick of the most
// likely free of an attack, held it; else red where its package is new
// since that version (`created`), as plain-crypto-js was to axios 1.14.1;
// yellow among npm's top 20,000, as a dependency named for another's peer
// or by a tool's config is (react, typescript, eslint), older and more
// downloaded than the package naming it; orange past them, or where its
// package isn't told.
export function npmUnusedDependencySeverity(told, kept) {
  if (kept) return 'moderate'
  if (told?.created) return 'critical'
  return told?.level && !npmTierLow(told.tier ?? Infinity) ? 'moderate' : 'high'
}
