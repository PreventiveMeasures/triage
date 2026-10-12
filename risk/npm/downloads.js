// A package's downloads, as npm's downloads API counts them a day
// (`{ start, end, days }`, the first day's date and a count a day from it):
// in weeks and months, the tier among npm's packages they put it in, and a
// dependency's to the day before its latest two weeks.

export const DAY_MS = 24 * 60 * 60_000
const dayOf = (start, offset) => new Date(Date.parse(start) + offset * DAY_MS)

// The downloads in 7-day weeks ending on the last day, oldest first, a
// partial oldest week left out: `{ from, to, total }`, dates as `Date`s.
export function npmDownloadWeeks(downloads) {
  const weeks = []
  if (!downloads?.days) return weeks
  for (let end = downloads.days.length - 1; end >= 6; end -= 7) {
    let total = 0
    for (let day = end - 6; day <= end; day++) total += downloads.days[day]
    weeks.push({ from: dayOf(downloads.start, end - 6), to: dayOf(downloads.start, end), total })
  }
  return weeks.toReversed()
}

// The downloads in calendar months (UTC), oldest first, the partial months
// at either end left out: `{ from, to, total }`, as npmDownloadWeeks has them.
export function npmDownloadMonths(downloads) {
  const months = []
  if (!downloads?.days) return months
  const start = Date.parse(downloads.start)
  let month = null
  downloads.days.forEach((count, i) => {
    const day = new Date(start + i * DAY_MS)
    if (day.getUTCDate() === 1) {
      month = { from: day, to: day, total: 0 }
      months.push(month)
    }
    if (month) { month.total += count; month.to = day }
  })
  const last = months.at(-1)
  if (last && new Date(last.to.getTime() + DAY_MS).getUTCDate() !== 1) months.pop()
  return months
}

// The weekly downloads from which a package is among npm's top 10, 20, 50,
// 100, …, 100,000 packages, rounded: download-counts' snapshot of a month's
// downloads (Jan 30 – Feb 28, 2026), each rank's count grown by the median
// growth of the packages ranked around it to the 30 days Sep 9 – Oct 8,
// 2026, as npm counts them, days it failed to count among them, then made a
// week. An estimate, to be revisited. Below the last, a package is
// unpopular (Infinity).
const TIERS = [
  [10, 550e6], [20, 405e6], [50, 285e6], [100, 225e6], [200, 165e6], [500, 95e6], [1000, 50e6], [2000, 20e6], [5000, 4e6],
  [10_000, 850e3], [20_000, 155e3], [50_000, 18e3], [100_000, 2e3], [Infinity, 0],
]

// The tier a package's downloads put it in (TIERS), by the most it had in any
// of its latest six 7-day weeks (npmDownloadWeeks): a week lower for a day
// npm failed to count, as it now and then does, or for a holiday, is passed
// over. Infinity for an unpopular one; null without a week.
export function npmDownloadTier(downloads) {
  const latest = npmDownloadWeeks(downloads).slice(-6)
  if (latest.length === 0) return null
  const most = Math.max(...latest.map(week => week.total))
  return TIERS.find(([, from]) => most >= from)[0]
}

// A tier's name, and its tint: solid green to the top 200, green to the top
// 5,000, yellow to the top 20,000, orange to the top 100,000, and red for
// the unpopular, a package few would notice changing.
export const npmTierLevel = tier => tier <= 200 ? 'is-solid' : tier <= 5000 ? 'is-top' : tier <= 20_000 ? 'is-mid' : tier <= 100_000 ? 'is-low' : 'is-unpopular'
// A dependency's downloads to the day before its latest two weeks: a
// package a release just pulled in, as a compromised one depending on it
// would, could owe those to that release alone. Its own package's tier goes
// by all of them, its Overview charting them.
const DEPENDENCY_DAYS_LEFT_OUT = 14
export function npmSettledDownloads(downloads, now = Date.now()) {
  if (!downloads) return null
  const first = Math.floor(Date.parse(downloads.start) / DAY_MS), last = Math.floor(now / DAY_MS) - 1 - DEPENDENCY_DAYS_LEFT_OUT
  const days = downloads.days.slice(0, Math.max(0, last - first + 1))
  return { start: downloads.start, end: new Date((first + days.length - 1) * DAY_MS).toISOString().slice(0, 10), days }
}

// A tier orange or red, past the top 20,000: one few would notice changing,
// as a release past the top 20,000 is flagged (compare.js).
export const npmTierLow = tier => tier > 20_000
