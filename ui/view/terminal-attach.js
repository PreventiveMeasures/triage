// Lazy loader for the bundle terminal UI. Mirrors the prism /
// brotli pattern: a runtime-string dynamic import keeps the lit
// component AND the `@preventive/terminal` API module out of the main view.js
// bundle. First call kicks the fetch; subsequent calls share the
// same promise so terminal.js is downloaded + parsed once per
// session.
//
// Session preservation across tab switches:
// The slide body's `choose(tab, …)` rebuilds the DOM whenever the
// active tab changes, so the `<div id="bundle-terminal-slot">` we
// targeted on the last attach is gone by the time the user
// returns to Terminal. To keep the running shell session alive
// (history, output, cwd), the `<bundle-terminal>` element itself
// is cached at the module level — detached from the document when
// Lit blows away its parent, re-appended to the new slot on
// re-entry. State lives on the element instance and survives
// disconnect / reconnect. The cache is keyed by bundle integrity,
// so opening a different bundle discards the previous terminal.

import { bundleSourcesAsMap } from './bundle-sources.js'
import { stripCommonPathPrefix } from './format.js'

let loadPromise = null
let cached = null

function loadTerminal() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    // Path held in a variable + the `@vite-ignore` annotation tells
    // the bundler to leave this dynamic import alone — keeps
    // terminal.js (and the prismjs-sized lit + shell payload it
    // pulls) out of the main bundle. Browser resolves it against the
    // page URL, so this works at any deploy path.
    const path = './terminal.js'
    try {
      return await import(/* @vite-ignore */ path)
    } catch (err) {
      // Don't pin the module to a rejected promise — a transient
      // failure (offline at first attach, stale service-worker
      // cache, etc.) would otherwise make every future call
      // replay the same rejection forever. Reset so the next
      // attachTerminal() retries the import from scratch.
      loadPromise = null
      throw err
    }
  })()
  return loadPromise
}

// Strip the shared build-root prefix from every path so the
// terminal's filesystem matches what the Code tab's tree shows
// (and so `cd /` lands on a useful root, not on the deploy path).
function buildSourcesFromDetails(details) {
  const raw = bundleSourcesAsMap(details)
  if (raw.size === 0) return raw
  const keys = [...raw.keys()]
  const { stripped } = stripCommonPathPrefix(keys)
  const out = new Map()
  for (let i = 0; i < keys.length; i++) out.set(stripped[i], raw.get(keys[i]))
  return out
}

export async function attachTerminal(host, details) {
  const tag = details?.integrity ?? ''
  // Race fix: cache a Promise<element> (not the resolved element)
  // keyed by integrity, set BEFORE awaiting. Concurrent calls
  // during the dynamic import — e.g. two render() passes fire in
  // quick succession before the lit module finishes loading — all
  // see the same in-flight cache entry, await the same promise,
  // and end up with the same element. Without this, each pending
  // call would race past `cached === null` and create a fresh
  // <bundle-terminal>, wiping the session that another call had
  // already started building.
  if (!cached || cached.integrity !== tag) {
    cached = { integrity: tag, promise: createMount(details, tag) }
  }
  try {
    const el = await cached.promise
    // If the host that was passed in is no longer in the document,
    // an earlier attachTerminal call (kicked off before a tab-flip
    // render rebuilt the slot) is resuming after the slot it
    // targeted got removed. Touching the element now would move
    // it into the detached slot and hide the terminal until the
    // next render fires. Bail — the call that owns the live host
    // (issued by that next render) will re-attach.
    if (!host.isConnected) return el
    // Cheap re-attach: render() fires on every state change; the
    // session should survive a tab flip even when Lit rebuilt the
    // slot div around us (`host` is a new node, element is detached).
    if (host.contains(el)) return el
    host.replaceChildren(el)
    return el
  } catch (err) {
    // Drop the cache so a future attempt isn't stuck on a stale
    // rejection. `err` isn't guaranteed to be an Error (a bundler
    // can reject with a non-Error in module-load failures), so
    // fall through to String() rather than reading .message on
    // something that might not have one.
    cached = null
    const msg = err instanceof Error ? err.message : String(err)
    host.textContent = `Terminal failed to load: ${msg}`
    return null
  }
}

async function createMount(details, tag) {
  const mod = await loadTerminal()
  return mod.createTerminalElement(buildSourcesFromDetails(details), tag)
}
