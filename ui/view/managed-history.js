import { managedRoutePath, parseManagedRoute } from '../../common/managed/routes.js'
import { encodeFindingRef, extractFindingRef } from '../../client/finding-link.js'

const KEY = 'deepviewManagedNavigation'
const LOGIN_FINDING = 'deepviewManagedLoginFinding'

// Browser history contains only a navigation generation, never report data.
// A mode change invalidates old entries; Back cannot restore the prior mode.
export function createManagedHistory(browser) {
  let active = false
  let generation = null
  let revision = 0
  let restore = null
  let currentPath = null
  let listening = false
  let findingUrl = null

  function routeAt(url) {
    const route = parseManagedRoute(url)
    const finding = extractFindingRef(url.hash)
    return route ? { ...route, ...(finding ? { finding } : {}) } : null
  }

  function takeLoginFinding() {
    try {
      const saved = browser.sessionStorage?.getItem(LOGIN_FINDING)
      browser.sessionStorage?.removeItem(LOGIN_FINDING)
      if (!saved) return null
      const url = new URL(saved, browser.location.origin)
      const route = url.origin === browser.location.origin ? routeAt(url) : null
      return route?.finding ? route : null
    } catch { return null }
  }

  function onHash() {
    if (!active || !extractFindingRef(browser.location.hash) || findingUrl === browser.location.href) return
    if (browser.history.state?.[KEY] && browser.history.state[KEY] !== generation) return
    const url = findingUrl = browser.location.href
    const route = routeAt(new URL(url))
    void navigate(route ?? { view: 'home' }, { replace: true }).finally(() => { if (findingUrl === url) findingUrl = null })
  }

  function replace(path) {
    browser.history.replaceState(active ? { [KEY]: generation } : null, '', path)
    currentPath = path
  }

  async function navigate(route, { replace: replacing = false, pop = false } = {}) {
    if (!active || !restore) return false
    route ??= { view: 'home' }
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
    if ((!event.state?.[KEY] || event.state[KEY] === generation) && extractFindingRef(browser.location.hash)) { onHash(); return }
    const route = event.state?.[KEY] === generation ? routeAt(new URL(browser.location.href)) : null
    void navigate(route ?? { view: 'home' }, { pop: true })
  }

  function onClick(event) {
    if (!active || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    // Finding cards live in shadow roots. Intercept ordinary self-link
    // clicks before a cross-report navigation can unload pending triage.
    const anchor = event.composedPath().find(node => node.matches?.('a.comment-self-ref[href]'))
    if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return
    const url = new URL(anchor.href)
    if (url.origin !== browser.location.origin) return
    const route = routeAt(url)
    if (!route?.finding) return
    event.preventDefault()
    return navigate(route)
  }

  return {
    get active() { return active },
    rememberFinding() {
      const route = routeAt(new URL(browser.location.href))
      if (!route?.finding) return
      // OAuth returns to `/`. Retain only the destination in this tab until
      // its authenticated startup; no report contents enter browser storage.
      try { browser.sessionStorage?.setItem(LOGIN_FINDING, `${managedRoutePath(route)}#${encodeFindingRef(route.finding)}`) } catch {}
    },
    start(navigateToPage) {
      if (active) return
      active = true
      restore = navigateToPage
      generation = typeof browser.history.state?.[KEY] === 'string' ? browser.history.state[KEY] : browser.crypto.randomUUID()
      if (!listening) {
        browser.addEventListener('popstate', onPop)
        browser.addEventListener('hashchange', onHash)
        browser.addEventListener('click', onClick)
        browser.launchQueue?.setConsumer(({ targetURL }) => {
          if (!active || !targetURL) return
          const url = new URL(targetURL)
          if (url.origin !== browser.location.origin) return
          const route = routeAt(url)
          if (route) void navigate(route)
        })
        listening = true
      }
      const pending = takeLoginFinding()
      let route = routeAt(new URL(browser.location.href)) ?? { view: 'home' }
      if (pending && route.view === 'home' && !route.finding) route = pending
      return navigate(route, { replace: true })
    },
    navigate,
    reset({ force = false } = {}) {
      ++revision
      if (active || force) {
        try { browser.sessionStorage?.removeItem(LOGIN_FINDING) } catch {}
        active = false
        generation = null
        restore = null
        replace('/')
      }
    },
  }
}

export const managedHistory = typeof window === 'undefined' ? null : createManagedHistory(window)
