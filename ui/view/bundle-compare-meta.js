// What a stasis bundle records of a file beside its bytes, where it changed
// (bundle-compare-diff.js computeBundleDiff's `meta`), as Compare's Overview
// and Code show it: tags in a file's row, head and tree row, and sentences
// for a file whose contents read the same.
import { html } from 'lit'
import { Bundle } from '@exodus/stasis-core/bundle'

// How a file's format changed, said, `none` where the bundle records none
// (stasis runs it as code): and whether from data to code, or code to data.
function formatSaid(from, to) {
  const now = to === undefined ? 'The bundle records no format for it now' : `The bundle loads it as ${to}`
  const was = from === undefined ? 'no format recorded before' : to === undefined ? `${from} before` : `as ${from} before`
  const [data, nowData] = [Bundle.isResourceFormat(from), Bundle.isResourceFormat(to)]
  return `${now}, ${was}${data === nowData ? '' : data ? ', carried as data before, run as code now' : ', run as code before, carried as data now'}`
}

// What a stasis bundle records of a file that changed (computeBundleDiff's
// `meta`), as warnings in its head, its tree row (`compact`) and its
// Overview row: its format, from the one to the other (`none` unrecorded);
// an execute bit set (+x) or cleared (−x); and its being an entry point of
// the bundle, new or dropped. What it no longer is, struck through.
export function fileMetaTags(meta = [], compact = false) {
  return meta.map(({ field, from, to }) => {
    if (field === 'format') return html`<span class="bundle-compare-code-meta">${compact ? 'format' : `${from ?? 'none'} → ${to ?? 'none'}`}</span>`
    const label = field === 'executable' ? (to ? '+x' : '−x') : to ? 'new entry' : 'entry'
    return html`<span class=${`bundle-compare-code-meta${to ? '' : ' is-dropped'}`}>${label}</span>`
  })
}

// The same as flags (file-flags.js), each a warning's: what it is now, not
// what it no longer is, struck through.
export const fileMetaFlags = (meta = []) => meta.filter(({ field, to }) => field === 'format' || to)
  .map(({ field, from, to }) => ({ name: field === 'format' ? `${from ?? 'none'} → ${to ?? 'none'}` : field === 'executable' ? '+x' : 'new entry', severity: 'high' }))

// The same, said in sentences, for a file whose contents read the same.
export function metaSentences(meta = []) {
  return meta.map(({ field, from, to }) => field === 'format' ? `${formatSaid(from, to)}.`
    : field === 'executable' ? (to ? 'It is now executable.' : 'It is no longer executable.')
    : to ? 'It is now an entry point of the bundle.' : 'It is no longer an entry point of the bundle.').join(' ')
}
