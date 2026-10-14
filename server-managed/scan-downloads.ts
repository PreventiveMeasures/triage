// A scan's packages' downloads, as risk asks them, readied before the
// packages are assessed (repository-risk.ts), so that no assessment waits on
// npm's downloads API, which answers some 40 lookups a minute: a package is
// given to the assessors once its downloads are kept (npm-risk.ts
// npmReadyScanDownloads), those that can be readied at once (kept already,
// and unscoped ones, asked in bulk) first, each lockfile's as it is read, and
// the rest (scoped ones, which npm answers only one by one) one at a time,
// at the pace npm allows, while the assessors go on with the others.
import { setTimeout as delay } from 'node:timers/promises'
import { type Queue, queue } from './queue.ts'

export interface DownloadsSource {
  // Readies those of `names` that can be at once, `ready` told each.
  atOnce(names: string[], ready: (name: string) => void, signal: AbortSignal): Promise<void>
  // Readies one on its own.
  one(name: string, signal: AbortSignal): Promise<void>
}

// How npm asking to be asked later is told (`busy`), and waited on: asked
// again after a wait, up to `retries` times running.
export interface DownloadsPacing { busy(error: unknown): boolean; retries: number; waitMs: number }

export interface ReadyingDownloads<T> {
  // Packages to give once their downloads are ready.
  add(items: T[]): void
  // Once all added are given, or the scan stops.
  close(): Promise<void>
}

// Readies the downloads of the packages added, each given (`give`) once its
// name's are, or once readying them fails otherwise than npm asking to wait,
// or npm keeps asking past `retries`: its assessment then asks its own.
export function readyingDownloads<T extends { name: string }>(source: DownloadsSource, signal: AbortSignal, give: (item: T) => void,
  { busy, retries, waitMs }: DownloadsPacing): ReadyingDownloads<T> {
  const waiting = new Map<string, T[]>()
  const atOnce: Queue<string[]> = queue(signal), oneByOne: Queue<string> = queue(signal)
  const release = (name: string) => { for (const item of waiting.get(name) ?? []) give(item); waiting.delete(name) }
  const wait = async (attempt: number) => { try { await delay(waitMs * Math.min(attempt + 1, 5), undefined, { signal }); return true } catch { return false } }

  // A lockfile's names, those that can be readied at once, again after a wait
  // where npm asks: false once the scan stops.
  const readyNow = async (names: string[]) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const left = names.filter(name => waiting.has(name))
      try { await source.atOnce(left, release, signal); return true } catch (error) {
        if (signal.aborted) return false
        if (!busy(error)) { for (const name of left) release(name); return true }
        if (!await wait(attempt)) return false
      }
    }
    return true
  }
  // Each lockfile's, the rest left to oneByOne.
  const readyAtOnce = async () => {
    for (let names = await atOnce.take(); names !== undefined; names = await atOnce.take()) {
      if (!await readyNow(names)) return
      for (const name of names) if (waiting.has(name)) oneByOne.add(name)
    }
  }
  const readyOneByOne = async () => {
    for (let name = await oneByOne.take(); name !== undefined; name = await oneByOne.take()) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try { await source.one(name, signal); break } catch (error) {
          if (signal.aborted) return
          if (!busy(error) || !await wait(attempt)) break
        }
      }
      release(name)
    }
  }
  const lanes = [readyAtOnce().finally(() => { oneByOne.close() }), readyOneByOne()]
  return {
    add(items) {
      const names: string[] = []
      for (const item of items) {
        const kept = waiting.get(item.name)
        if (kept) kept.push(item)
        else { waiting.set(item.name, [item]); names.push(item.name) }
      }
      if (names.length > 0) atOnce.add(names)
    },
    async close() {
      atOnce.close()
      await Promise.all(lanes)
    },
  }
}
