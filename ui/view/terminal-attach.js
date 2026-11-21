// Lazy loader for the bundle terminal: a runtime-string import keeps the
// component and `@preventive/terminal` out of view.js, fetched and parsed
// once. The slot it attaches to is rebuilt as tabs switch (Terminal, and
// the Code tab's pane, show the same one), so the `<bundle-terminal>`
// element is cached here by bundle integrity and moved into each new slot:
// its shell session (history, output, cwd) lives on the element.

import { bundleFilesAsMap } from '../../common/bundle-sources.js'
import { stripCommonPathPrefix } from './format.js'

let loadPromise = null
let cached = null

export function resetBundleTerminal() { cached = null }

// Put the caret on the shown terminal's command line, once it is attached.
// A terminal focuses itself on its first render only, so the Code tab's
// pane, opening on one already used, asks for it here.
export async function focusTerminal() {
  const el = await cached?.promise.catch(() => null)
  if (el?.isConnected) el.focusInput()
}

function loadTerminal() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    // A variable, so esbuild leaves it to the browser, which resolves it
    // against the page URL.
    const path = './terminal.js'
    try {
      return await import(path)
    } catch (err) {
      // Not pinned to a rejection: the next attach retries.
      loadPromise = null
      throw err
    }
  })()
  return loadPromise
}

// The bundle's files under the paths the Code tab's tree shows, the shared
// build-root prefix stripped (terminal.js MOUNT); values untouched, but a
// binary known by its digest alone, which the terminal can't hold, left
// out as the tree leaves it out.
function buildSourcesFromDetails(details) {
  const raw = new Map([...bundleFilesAsMap(details)].filter(([, file]) => file?.format !== 'digest'))
  if (raw.size === 0) return raw
  const keys = [...raw.keys()]
  const { stripped } = stripCommonPathPrefix(keys)
  return new Map(keys.map((key, i) => [stripped[i], raw.get(key)]))
}

export async function attachTerminal(host, details) {
  const tag = details?.integrity ?? ''
  // The element's promise cached before awaiting, so renders racing the
  // import share one element rather than each starting a session.
  if (!cached || cached.integrity !== tag || ((details?.managedId || cached.managedId) && cached.details !== details)) {
    cached = { integrity: tag, managedId: details?.managedId, details: details?.managedId ? details : null, promise: createMount(details, tag) }
  }
  try {
    const el = await cached.promise
    // A slot a later render has replaced: the call owning the live one
    // attaches it.
    if (!host.isConnected) return el
    if (host.contains(el)) return el
    host.replaceChildren(el)
    return el
  } catch (err) {
    // Not stuck on the rejection; it need not be an Error.
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
