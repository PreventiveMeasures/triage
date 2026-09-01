// Syntax colouring for the fenced code blocks a finding description
// carries (format.js codeBlockSegments splits them out;
// render-finding.js codeBlockTemplate draws them). Prism rides in its
// own lazily-imported bundle and its first highlight call is async,
// while a card's template is sync — so this module is the bridge:
// `highlightedCode` answers from a cache, and kicks the work on a
// miss.
//
// Same plumbing as focus-code.js's highlight path (the source viewer's
// version of this problem), and for the same reason: on settle it
// bumps a state tick so observer-util-tracked consumers (the
// `<finding-card>` autoruns) see the cache change as a state
// mutation, and calls the top-level render() for the light-DOM
// surfaces that aren't state-tracked (the bundle views'
// descriptions). Neither alone is enough — the tick doesn't reach the
// light DOM, and a bare render() doesn't always propagate into a
// shadow root whose autorun tracked nothing that changed.
import { state } from '#client/index.js'
import { langForTag, highlight as prismHighlight } from './prism-highlight.js'
import { render } from './render.js'

// `${lang}\0${code}` → highlighted HTML, or null once we know prism
// can't colour this block (the caller renders plain text either way).
// Not evicted: the keys are the snippets of the reports the user has
// open, every render asks for the same handful again, and dropping
// them would only buy a re-highlight of what we just computed.
const cache = new Map()
const pending = new Set()

// One notify per settle BATCH, not per block. Prism's first call
// downloads the bundle and every block waiting on it resolves in the
// same microtask drain, so a report whose findings carry a hundred
// snippets would otherwise bump the tick and re-render a hundred
// times over for one batch of work. The flag collapses that into a
// single repaint; blocks that settle later (a second report dropped
// in) get their own.
let notifyScheduled = false

function notifySettled() {
  if (notifyScheduled) return
  notifyScheduled = true
  // The fresh microtask also keeps render() off the await-resolution
  // stack — the ordering fix focus-code.js documents, where a render
  // mid-chain occasionally committed before the template saw the new
  // cache entry.
  queueMicrotask(() => {
    notifyScheduled = false
    state.codeBlockTick++
    render()
  })
}

// Highlighted HTML for one block, or null to render it as plain text
// — which is the answer for an unlisted language (see langForTag's
// allowlist), an empty block, and every call before the highlight
// settles. Prism escapes the source itself, so a returned string is
// safe to inject with `unsafeHTML`.
export function highlightedCode(code, tag) {
  const lang = langForTag(tag)
  if (!lang || !code) return null
  const key = `${lang}\0${code}`
  if (cache.has(key)) return cache.get(key)
  if (pending.has(key)) return null
  pending.add(key)
  void (async () => {
    // prismHighlight resolves null when the download or the grammar
    // lookup fails; caching that null is what stops a block prism
    // can't colour from re-arming this on every render.
    const html = await prismHighlight(code, lang)
    cache.set(key, html ?? null)
    pending.delete(key)
    notifySettled()
  })()
  return null
}
