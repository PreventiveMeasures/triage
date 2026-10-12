import { html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { fileLineCounts } from './bundle-compare-code-model.js'

export const KINDS = [
  { kind: 'changed', label: 'Modified', letter: 'M' },
  { kind: 'renamed', label: 'Renamed', letter: '→' },
  { kind: 'added', label: 'Added', letter: 'A' },
  { kind: 'removed', label: 'Removed', letter: 'D' },
  { kind: 'repointed', label: 'Repointed', letter: 'R' },
]
export const KIND = Object.fromEntries(KINDS.map(entry => [entry.kind, entry]))

export function renderFileChange({ kind, modified }, tooltip = nothing) {
  return html`<span class=${classMap({ 'bundle-compare-code-letter': true, [kind]: true, pure: kind === 'renamed' && !modified })}
    data-tooltip=${tooltip}>${KIND[kind].letter}</span>`
}

// Shared by Compare and Review: zero counts on renames stay aligned but hidden,
// and a pure rename gets an equals sign. No line counts for non-text files.
export function renderFileLineCounts(counts, kind, modified) {
  if (!counts || kind === 'repointed') return nothing
  const { additions, deletions } = counts
  const renamed = kind === 'renamed'
  if ((renamed || modified === false) && additions === 0 && deletions === 0) {
    return html`<span class="bundle-compare-code-line-counts unchanged" aria-label="No line changes">=</span>`
  }
  return html`<span class="bundle-compare-code-line-counts" aria-label=${`${additions} added, ${deletions} removed lines`}>
    <span class=${classMap({ add: true, empty: renamed && additions === 0 })}>+${additions.toLocaleString()}</span>
    <span class=${classMap({ del: true, empty: kind === 'added' || (renamed && deletions === 0) })}>−${deletions.toLocaleString()}</span>
  </span>`
}

// Count a long tree over multiple renders, keeping each render responsive.
const COUNT_BUDGET_MS = 30
export class FileLineCounter {
  constructor(update) { this.update = update; this.counts = new Map() }
  begin() { clearTimeout(this.later); this.later = null; this.until = null }
  reset() { this.begin(); this.counts.clear() }
  get(key, contents) {
    if (this.counts.has(key)) return this.counts.get(key)
    const now = performance.now()
    this.until ??= now + COUNT_BUDGET_MS
    if (now > this.until) {
      this.later ??= setTimeout(() => { this.later = null; this.update() })
      return null
    }
    const { before, after } = contents()
    const counts = fileLineCounts(before, after)
    this.counts.set(key, counts)
    return counts
  }
}
