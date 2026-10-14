// Items in the order they are added, each taken once by whichever reader asks
// first: none once closed and all taken, or once `signal` aborts.
export interface Queue<T> { add(item: T): void; close(): void; take(): Promise<T | undefined> }
export function queue<T>(signal: AbortSignal): Queue<T> {
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
        if (signal.aborted) return undefined
        const item = items.shift()
        if (item !== undefined || closed) return item
        await new Promise<void>(resolve => { waiting.push(resolve) })
      }
    },
  }
}
