// Items in the order they are added, each taken once by whichever reader asks
// first: none once closed and all taken, or once `signal` aborts, but those
// added by then where `drain`, none waited for.
export interface Queue<T> { add(item: T): void; close(): void; take(): Promise<T | undefined> }
export function queue<T>(signal: AbortSignal, { drain = false } = {}): Queue<T> {
  const items: T[] = []
  const waiting: (() => void)[] = []
  let closed = false
  const wake = () => { for (const resolve of waiting.splice(0)) resolve() }
  signal.addEventListener('abort', wake, { once: true })
  return {
    add(item) { items.push(item); wake() },
    close() { closed = true; wake() },
    async take() {
      for (;;) {
        if (signal.aborted && !drain) return undefined
        const item = items.shift()
        if (item !== undefined || closed || signal.aborted) return item
        await new Promise<void>(resolve => { waiting.push(resolve) })
      }
    },
  }
}

// Work done `count` at a time, in the order asked, the rest waiting their
// turn.
export function inTurns(count: number): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async work => {
    if (active < count) active++
    else await new Promise<void>(resolve => { waiting.push(resolve) })
    try { return await work() } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}
