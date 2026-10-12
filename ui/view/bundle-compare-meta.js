// What a stasis bundle records of a file beside its bytes, where it changed
// (bundle-compare-diff.js computeBundleDiff's `meta`), as Compare's Overview
// and Code show it: tags in a file's row, head and tree row, and sentences
// for a file whose contents read the same.
import { html } from 'lit'

// A stasis format a file is carried in as data, not run as code.
const isResource = format => format === 'resource' || format.startsWith('resource:')
// How a file's format changed, said: from data to code, or code to data.
const formatNote = (from, to) => isResource(from) === isResource(to) ? '' : isResource(from) ? ', carried as data before, run as code now' : ', run as code before, carried as data now'

// What a stasis bundle records of a file that changed (computeBundleDiff's
// `meta`), as warnings in its head, its tree row (`compact`) and its
// Overview row: its format, from the one to the other; an execute bit set
// (+x) or cleared (−x); and its being an entry point of the bundle, new or
// dropped. What it no longer is, struck through.
export function fileMetaTags(meta = [], compact = false) {
  return meta.map(({ field, from, to }) => {
    if (field === 'format') {
      return html`<span class="bundle-compare-code-meta" data-tooltip=${`The bundle loads it as ${to}, as ${from} before${formatNote(from, to)}`}>${compact ? 'format' : `${from} → ${to}`}</span>`
    }
    const [label, now, then] = field === 'executable' ? [to ? '+x' : '−x', 'Now executable: the bundle sets its execute bit', 'No longer executable: the bundle clears its execute bit']
      : [to ? 'new entry' : 'entry', 'Now an entry point of the bundle', 'No longer an entry point of the bundle']
    return html`<span class=${`bundle-compare-code-meta${to ? '' : ' is-dropped'}`} data-tooltip=${to ? now : then}>${label}</span>`
  })
}

// The same, said in sentences, for a file whose contents read the same.
export function metaSentences(meta = []) {
  return meta.map(({ field, from, to }) => field === 'format' ? `The bundle loads it as ${to}, as ${from} before${formatNote(from, to)}.`
    : field === 'executable' ? (to ? 'It is now executable.' : 'It is no longer executable.')
    : to ? 'It is now an entry point of the bundle.' : 'It is no longer an entry point of the bundle.').join(' ')
}
