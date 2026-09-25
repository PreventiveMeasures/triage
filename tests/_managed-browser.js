import { setImmediate } from 'node:timers/promises'

export function browserAt(path = '/') {
  const entries = [{ url: new URL(path, 'https://triage.test'), state: null }]
  let index = 0, sequence = 0
  const listeners = new Map()
  const writes = []
  const saved = new Map()
  const browser = {
    get location() { return entries[index].url },
    crypto: { randomUUID: () => `generation-${++sequence}` },
    addEventListener: (event, listener) => listeners.set(event, listener),
    launchQueue: { setConsumer(consumer) { this.consume = consumer } },
    sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    history: {
      get state() { return entries[index].state },
      replaceState(state, _, url) { entries[index] = { state, url: new URL(url, browser.location) }; writes.push('replace') },
      pushState(state, _, url) { entries.splice(index + 1); entries.push({ state, url: new URL(url, browser.location) }); index++; writes.push('push') },
    },
    async move(delta) { index += delta; listeners.get('popstate')?.({ state: entries[index].state }); await setImmediate() },
    async hash(value) {
      entries[index].url.hash = value
      listeners.get('popstate')?.({ state: entries[index].state })
      listeners.get('hashchange')?.()
      await setImmediate()
    },
    async click(href, { target = '', download = false, self = true, ...init } = {}) {
      const anchor = {
        href: new URL(href, browser.location).href, target,
        hasAttribute: name => name === 'download' && download,
        matches: selector => self && selector === 'a.comment-self-ref[href]',
      }
      const event = {
        button: 0, defaultPrevented: false, ...init,
        // A nested node inside an anchor inside a finding card's shadow root.
        composedPath: () => [{}, anchor, {}, browser],
        preventDefault() { this.defaultPrevented = true },
      }
      await listeners.get('click')?.(event)
      await setImmediate()
      return event.defaultPrevented
    },
  }
  return { browser, entries, writes }
}
