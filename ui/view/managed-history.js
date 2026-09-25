import { managedRoutePath, parseManagedRoute } from '../../common/managed/routes.js'

const KEY = 'deepviewManagedNavigation'

// Browser history contains only a navigation generation, never report data.
// A mode change invalidates old entries; Back cannot restore the prior mode.
export function createManagedHistory(browser) {
  let active = false
  let generation = null
  let revision = 0
  let restore = null
  let currentPath = null
  let listening = false

  function replace(path) {
    browser.history.replaceState(active ? { [KEY]: generation } : null, '', path)
    currentPath = path
  }

  async function navigate(route, { replace: replacing = false, pop = false } = {}) {
    if (!active || !restore) return false
    let path = managedRoutePath(route)
    if (path === null) return false
    const request = ++revision
    const isCurrent = () => active && request === revision
    let ok = false
    try { ok = await restore(route, isCurrent) }
    catch (err) { console.warn('managed: navigation failed:', err) }
    if (!isCurrent()) return false
    if (!ok) {
      // Failed loads may already have cleared the old report. Always keep the
      // displayed page and URL together, including ordinary report clicks.
      await restore({ view: 'home' }, isCurrent)
      if (isCurrent()) replace('/')
      return false
    }
    // The renderer can fall back from Files when a report has no source tree.
    if (typeof ok === 'object') path = managedRoutePath(ok) ?? path
    if (pop || replacing) replace(path)
    else if (path !== currentPath) {
      browser.history.pushState({ [KEY]: generation }, '', path)
      currentPath = path
    }
    return true
  }

  function onPop(event) {
    if (!active) {
      // Only clean up this app's discarded managed entries. E2E navigation
      // otherwise neither writes history nor handles browser navigation.
      if (event.state?.[KEY]) replace('/')
      return
    }
    const route = event.state?.[KEY] === generation ? parseManagedRoute(new URL(browser.location.href)) : null
    void navigate(route ?? { view: 'home' }, { pop: true })
  }

  return {
    get active() { return active },
    start(navigateToPage) {
      if (active) return
      active = true
      restore = navigateToPage
      generation = typeof browser.history.state?.[KEY] === 'string' ? browser.history.state[KEY] : browser.crypto.randomUUID()
      if (!listening) {
        browser.addEventListener('popstate', onPop)
        browser.launchQueue?.setConsumer(({ targetURL }) => {
          if (!active || !targetURL) return
          const url = new URL(targetURL)
          if (url.origin !== browser.location.origin) return
          const route = parseManagedRoute(url)
          if (route) void navigate(route)
        })
        listening = true
      }
      const route = parseManagedRoute(new URL(browser.location.href)) ?? { view: 'home' }
      return navigate(route, { replace: true })
    },
    navigate,
    reset({ force = false } = {}) {
      ++revision
      if (active || force) {
        active = false
        generation = null
        restore = null
        replace('/')
      }
    },
  }
}

export const managedHistory = typeof window === 'undefined' ? null : createManagedHistory(window)
