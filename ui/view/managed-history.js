import { managedRoutePath, parseManagedRoute } from '../../common/managed/routes.js'
import { encodeFindingRef, extractFindingRef } from '../../client/finding-link.js'
import { parsePublicShare, publicSharePath } from '../../client/managed/public-share.js'

const KEY = 'deepviewManagedNavigation'
const LOGIN_FINDING = 'deepviewManagedLoginFinding'

function sameFindingsPage(a, b) {
  return a?.view === 'findings' && b?.view === 'findings'
    && a.teamSlug === b.teamSlug && (a.reportSlug ?? null) === (b.reportSlug ?? null)
}

function sameBundleCode(a, b) {
  return a?.view === 'bundles' && b?.view === 'bundles' && a.bundleTab === 'code' && b.bundleTab === 'code'
    && (a.teamSlug ?? null) === (b.teamSlug ?? null) && a.bundleSlug === b.bundleSlug
}

// Browser history contains only a navigation generation, never report data.
// A mode change invalidates old entries; Back cannot restore the prior mode.
export function createManagedHistory(browser) {
  const initialHash = browser.location.hash
  const publicShare = parsePublicShare(initialHash)
  let active = false
  let generation = null
  let revision = 0
  let restore = null
  let currentPath = null
  let listening = false
  let findingUrl = null
  let restoring = null

  // A changed public fragment triggers a document reload. Do not let an old
  // popstate handler or pending navigation restore the previous credential.
  function shareChanged() { return browser.location.hash.startsWith('#public=') && browser.location.hash !== initialHash }

  function routeAt(url) {
    const route = parseManagedRoute(url)
    const finding = route?.view === 'home' ? extractFindingRef(url.hash) : null
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
    if (shareChanged()) return
    path = publicSharePath(path, publicShare)
    browser.history.replaceState(active ? { [KEY]: generation } : null, '', path)
    currentPath = path
  }

  async function navigate(route, { replace: replacing = false, pop = false } = {}) {
    if (!active || !restore || shareChanged()) return false
    route ??= { view: 'home' }
    let path = managedRoutePath(route)
    if (path === null) return false
    const request = ++revision
    const pending = restoring = { route, findingRoute: null, codeRoute: null }
    const isCurrent = () => active && request === revision && !shareChanged()
    let ok = false
    try { ok = await restore(route, isCurrent) }
    catch (err) { console.warn('managed: navigation failed:', err) }
    if (!isCurrent()) return false
    if (!ok) {
      // Failed loads may already have cleared the old report. Always keep the
      // displayed page and URL together, including ordinary report clicks.
      await restore({ view: 'home' }, isCurrent)
      if (isCurrent()) { restoring = null; replace('/') }
      return false
    }
    // The renderer can fall back from Files when a report has no source tree.
    if (typeof ok === 'object') path = managedRoutePath(ok) ?? path
    // Rendering can select a default Focus finding, reveal a linked finding,
    // or hide details in a list view. Commit its final selection only after
    // this navigation succeeds; intermediate paints must not rewrite the
    // previous page's history entry or an incoming deep link.
    if (sameFindingsPage(pending.findingRoute, typeof ok === 'object' ? ok : route)) {
      path = managedRoutePath(pending.findingRoute)
    }
    if (sameBundleCode(pending.codeRoute, typeof ok === 'object' ? ok : route)) path = managedRoutePath(pending.codeRoute)
    restoring = null
    if (pop || replacing) replace(path)
    else if (publicSharePath(path, publicShare) !== currentPath) {
      path = publicSharePath(path, publicShare)
      browser.history.pushState({ [KEY]: generation }, '', path)
      currentPath = path
    }
    return true
  }

  function onPop(event) {
    if (shareChanged()) return
    if (!active) {
      // Only clean up this app's discarded managed entries. E2E navigation
      // otherwise neither writes history nor handles browser navigation.
      if (event.state?.[KEY]) replace('/')
      return
    }
    if ((!event.state?.[KEY] || event.state[KEY] === generation) && extractFindingRef(browser.location.hash)) { onHash(); return }
    // A pasted or typed line link to the open file changes only the
    // fragment, in an entry of its own. Adopt it, and let the Code tab
    // follow the hash, instead of reopening the bundle.
    if (!event.state?.[KEY]) {
      const route = routeAt(new URL(browser.location.href))
      const current = currentPath == null ? null : parseManagedRoute(new URL(currentPath, browser.location.href))
      if (route?.file != null && route.file === current?.file && sameBundleCode(route, current)) { replace(managedRoutePath(route)); return }
    }
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
      const path = route.view === 'home' ? `/#${encodeFindingRef(route.finding)}` : managedRoutePath(route)
      try { browser.sessionStorage?.setItem(LOGIN_FINDING, path) } catch {}
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
    replaceFindingRoute(route) {
      if (!active || route?.view !== 'findings' || shareChanged()) return
      const path = managedRoutePath(route)
      if (path == null) return
      if (restoring) {
        if (restoring.route.view === 'home' && restoring.route.finding
            || sameFindingsPage(route, { ...restoring.route, view: 'findings' })) restoring.findingRoute = route
        return
      }
      // A late repaint of a previous report must not steal the current URL.
      if (!sameFindingsPage(route, parseManagedRoute(new URL(browser.location.href)))) return
      if (publicSharePath(path, publicShare) !== currentPath) replace(path)
    },
    // The file a bundle's Code tab shows, as the tab renders it. Replaced, so
    // Back leaves the page rather than stepping through files, which the
    // tab's own history does; held for the end of a navigation that opens
    // the tab, like replaceFindingRoute's.
    replaceCodeRoute(route) {
      if (!active || shareChanged() || route?.view !== 'bundles' || route.bundleTab !== 'code') return
      const path = managedRoutePath(route)
      if (path == null) return
      if (restoring) {
        if (sameBundleCode(route, restoring.route)) restoring.codeRoute = route
        return
      }
      if (!sameBundleCode(route, parseManagedRoute(new URL(browser.location.href)))) return
      if (publicSharePath(path, publicShare) !== currentPath) replace(path)
    },
    replaceRoute(route) {
      if (!active || !route || shareChanged()) return
      const path = managedRoutePath(route)
      // A navigation still loading commits its own URL, from the state it
      // ends in. Written now, this one would land on the entry it leaves,
      // and match the entry it was about to push.
      if (path != null && !restoring) replace(path)
    },
    // A page the user moved to within the one shown, as a bundle's tab: an
    // entry of its own, so Back returns to the page before. The latest
    // navigation, so one still loading gives way to it.
    pushRoute(route) {
      if (!active || !route || shareChanged()) return
      let path = managedRoutePath(route)
      if (path == null) return
      ++revision
      restoring = null
      path = publicSharePath(path, publicShare)
      if (path === currentPath) return
      browser.history.pushState({ [KEY]: generation }, '', path)
      currentPath = path
    },
    reset({ force = false } = {}) {
      ++revision
      restoring = null
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
