// Syntax colouring for the fenced code blocks of a finding description
// (format.js codeBlockSegments, render-finding.js codeBlockTemplate). Prism
// loads lazily and highlights async while a card's template is sync, so
// `highlightedCode` answers from a cache and starts the work on a miss. On
// settle it bumps a state tick (for the observer-tracked `<finding-card>`
// autoruns) AND calls render() (for the light-DOM surfaces): neither alone
// reaches both — as in focus-code.js's highlight path.
import { state } from '#client/index.js'
import { langForTag, highlight as prismHighlight } from './prism-highlight.js'
import { render } from './render.js'

// `${lang}\0${code}` → highlighted HTML, or null where prism can't colour
// it. Never evicted: the keys are the open reports' snippets, asked for
// again on every render.
const cache = new Map()
const pending = new Set()

// One notify per settle BATCH: every block waiting on prism's download
// resolves in one microtask drain, and a hundred snippets must not mean a
// hundred re-renders.
let notifyScheduled = false

function notifySettled() {
  if (notifyScheduled) return
  notifyScheduled = true
  // The fresh microtask also keeps render() off the await-resolution
  // stack, where it could commit before the template saw the new entry
  // (focus-code.js).
  queueMicrotask(() => {
    notifyScheduled = false
    state.codeBlockTick++
    render()
  })
}

// Highlighted HTML for one block, or null for plain text: an unlisted
// language (langForTag's allowlist), an empty block, or before the
// highlight settles. Prism escapes the source, so the string goes in with
// `appMarkup`, whose check it passes.
export function highlightedCode(code, tag) {
  const lang = langForTag(tag)
  if (!lang || !code) return null
  const key = `${lang}\0${code}`
  if (cache.has(key)) return cache.get(key)
  if (pending.has(key)) return null
  pending.add(key)
  void (async () => {
    // A failed download or grammar lookup resolves null; caching it keeps
    // such a block from re-arming this on every render.
    const html = await prismHighlight(code, lang)
    cache.set(key, html ?? null)
    pending.delete(key)
    notifySettled()
  })()
  return null
}
