// Many packages' recent downloads at once, for the tier each is in by them
// (npm-downloads-chart.js npmDownloadTier), as the npm viewer tags each
// dependency a version adds with its package's: from the first of the
// month before last to yesterday. The viewer leaves out a dependency's
// latest two weeks, and goes by six weeks and the last whole month before
// them, so an answer is kept for two weeks: a newer one would add only days
// it leaves out. npm's range API takes up to 128 unscoped names in one
// request, a scoped one only alone; it is asked without credentials, as it
// answers anyone. A package's whole year, where kept for its own Overview
// (npm-insights.ts), answers for it.
import { kept } from './kept.ts'
import { type NpmDownloads, keptNpmDownloads, readDownloads } from './npm-insights.ts'
import { NpmPackageError, plainObject, readLimited } from './npm-packages.ts'

const DOWNLOADS_API = 'https://api.npmjs.org/downloads/range'
const BULK = 128
const SCOPED_AT_ONCE = 4
const API_TIMEOUT_MS = 30_000
const API_BYTES = 8 * 1024 * 1024
const DAY_MS = 24 * 60 * 60_000
// The most names one request of the viewer's may ask about, and how long
// all of them may take: those npm hasn't answered by then are left out.
export const MAX_DOWNLOAD_COUNTS = 512
const DEADLINE_MS = 60_000

const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10)
function rangeAt(now: number): string {
  const today = new Date(now)
  return `${isoDay(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 2, 1))}:${isoDay(now - DAY_MS)}`
}

// npm's answer for `names` over `range`, by name: null where npm has none;
// given up on where `stop` says so.
async function ask(range: string, names: string[], stop: AbortSignal): Promise<Map<string, NpmDownloads | null>> {
  let res: Response
  try {
    res = await fetch(`${DOWNLOADS_API}/${range}/${names.map(name => name.replace('/', '%2f')).join(',')}`,
      { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.any([stop, AbortSignal.timeout(API_TIMEOUT_MS)]) })
  } catch { throw new NpmPackageError(502, 'upstream-unavailable') }
  if (res.status === 404) { await res.body?.cancel(); return new Map(names.map(name => [name, null])) }
  if (!res.ok) { await res.body?.cancel(); throw new NpmPackageError(502, 'upstream-unavailable') }
  let json: unknown
  try { json = JSON.parse((await readLimited(res, API_BYTES)).toString('utf8')) } catch { throw new NpmPackageError(502, 'upstream-invalid') }
  // One name is answered alone; many, each by its name.
  if (names.length === 1) return new Map([[names[0]!, readDownloads(json)]])
  if (!plainObject(json)) throw new NpmPackageError(502, 'upstream-invalid')
  return new Map(names.map(name => [name, json[name] == null ? null : readDownloads(json[name])]))
}

const recent = kept<NpmDownloads | null>(5000, undefined, 14 * DAY_MS)

// The recent downloads of each of `names`, by name, null where npm has
// none; one npm couldn't be asked about, or hadn't answered for by the
// deadline or by when `signal` aborts (as its reader leaves), is left out.
export async function npmDownloadCounts(names: string[], now = Date.now(), signal: AbortSignal | null = null): Promise<Record<string, NpmDownloads | null>> {
  const range = rangeAt(now)
  const stop = AbortSignal.any([AbortSignal.timeout(DEADLINE_MS), ...signal ? [signal] : []])
  const waiting = new Map<string, PromiseWithResolvers<NpmDownloads | null>>()
  const answers = names.map(name => {
    const year = keptNpmDownloads(name)
    return year === undefined ? recent(name, () => {
      const asked = Promise.withResolvers<NpmDownloads | null>()
      waiting.set(name, asked)
      return asked.promise
    }) : Promise.resolve(year)
  })
  const settle = async (group: string[]) => {
    try {
      const found = await ask(range, group, stop)
      for (const name of group) waiting.get(name)!.resolve(found.get(name) ?? null)
    } catch (error) {
      for (const name of group) waiting.get(name)!.reject(error)
    }
  }
  const unasked = [...waiting.keys()]
  const plain = unasked.filter(name => !name.startsWith('@')), scoped = unasked.filter(name => name.startsWith('@'))
  for (let at = 0; at < plain.length; at += BULK) void settle(plain.slice(at, at + BULK))
  void (async () => {
    for (let at = 0; at < scoped.length; at += SCOPED_AT_ONCE) await Promise.all(scoped.slice(at, at + SCOPED_AT_ONCE).map(name => settle([name])))
  })()
  const settled = await Promise.allSettled(answers)
  return Object.fromEntries(names.flatMap((name, i) => {
    const answer = settled[i]!
    return answer.status === 'fulfilled' ? [[name, answer.value]] : []
  }))
}
