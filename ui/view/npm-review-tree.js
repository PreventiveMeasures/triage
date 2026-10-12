import { LitElement, html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { repeat } from 'lit/directives/repeat.js'
import { COLLAPSE_DIRS_ICON, NEXT_ICON } from './lit-icons.js'
import { sourceFileIcon } from './source-file-icon.js'
import { FileLineCounter, renderFileChange, renderFileLineCounts } from './bundle-compare-tree.js'
import { verdictIcon, verdictLabels } from './npm-review-presentation.js'

export function reviewTree(files, states) {
  const root = { children: new Map(), total: 0, checked: 0 }
  for (const file of files) {
    let node = root
    const checked = Boolean(states.get(file.path)?.status), parts = file.path.split('/')
    node.total++; node.checked += Number(checked)
    parts.forEach((name, index) => {
      if (!node.children.has(name)) node.children.set(name, { name, path: parts.slice(0, index + 1).join('/'), children: new Map(), total: 0, checked: 0 })
      node = node.children.get(name)
      node.total++; node.checked += Number(checked)
      if (index === parts.length - 1) node.file = file
    })
  }
  return root
}

export class NpmReviewTree extends LitElement {
  static properties = { files: { attribute: false }, states: { attribute: false }, path: {}, unchecked: { type: Boolean },
    _query: { state: true }, _expanded: { state: true }, _limit: { state: true } }
  createRenderRoot() { return this }
  constructor() { super(); this.files = []; this.states = new Map(); this._query = ''; this._expanded = new Set(); this._limit = 300; this._lineCounter = new FileLineCounter(() => this.requestUpdate()) }
  willUpdate(changed) {
    if (changed.has('files') || changed.has('states')) this._tree = reviewTree(this.files, this.states)
    if (changed.has('files')) {
      this._expanded = new Set([...this._tree.children.values()].filter(node => !node.file).map(node => node.path))
      this._lineCounter.reset()
    }
    if (changed.has('path')) {
      const parts = (this.path ?? '').split('/')
      this._expanded = new Set(this._expanded)
      for (let i = 1; i < parts.length; i++) this._expanded.add(parts.slice(0, i).join('/'))
      this._limit = 300
    }
  }
  disconnectedCallback() { super.disconnectedCallback(); this._lineCounter.begin() }
  updated(changed) {
    if (changed.has('path')) this.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }
  _select(path) { this.dispatchEvent(new CustomEvent('review-file-select', { detail: { path }, bubbles: true, composed: true })) }
  _filter(unchecked) { this.dispatchEvent(new CustomEvent('review-file-filter', { detail: { unchecked }, bubbles: true, composed: true })) }
  _rows(node, depth = 0) {
    const query = this._query.trim().toLowerCase()
    return [...node.children.values()].toSorted((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name)).flatMap(child => {
      if (this.unchecked && child.checked === child.total) return []
      if (child.file) return !query || child.path.toLowerCase().includes(query) ? [{ ...child, depth }] : []
      const open = Boolean(query) || this._expanded.has(child.path)
      const children = open ? this._rows(child, depth + 1) : []
      if (query && children.length === 0) return []
      return [{ ...child, depth, open }, ...open ? children : []]
    })
  }
  _lineCounts(file) { return renderFileLineCounts(this._lineCounter.get(file, () => file), file.kind) }
  render() {
    this._lineCounter.begin()
    const tree = this._tree ?? reviewTree(this.files, this.states)
    const rows = this._rows(tree)
    return html`<div class="npm-review-tree-head"><strong>Files <span class="npm-review-count">${tree.total}</span></strong>
      <button type="button" class="npm-review-icon-button" aria-label="Collapse folders" data-tooltip="Collapse folders"
        @click=${() => { this._expanded = new Set(); this._query = ''; this._limit = 300 }}>${COLLAPSE_DIRS_ICON}</button></div>
      <label class="npm-review-search"><input type="search" placeholder="Find a file…" aria-label="Find a file" .value=${live(this._query)}
        @input=${event => { this._query = event.target.value; this._limit = 300 }}></label>
      <div class="npm-review-filters" aria-label="Filter review files">
        <button type="button" aria-pressed=${String(!this.unchecked)} @click=${() => this._filter(false)}>All ${tree.total}</button>
        <button type="button" aria-pressed=${String(!!this.unchecked)} @click=${() => this._filter(true)}>Unchecked ${tree.total - tree.checked}</button>
      </div>
      <div class="npm-review-tree-scroll"><ul aria-label="Review files">
        ${repeat(rows.slice(0, this._limit), row => row.path, row => html`<li>
          ${row.file ? html`<button type="button" class="npm-review-tree-file" style=${`padding-left:${8 + row.depth * 12}px`}
            aria-current=${row.path === this.path ? 'true' : nothing}
            aria-label=${`${row.path}, ${verdictLabels[this.states.get(row.path)?.status] ?? 'Not reviewed'}`} @click=${() => this._select(row.path)}>
            ${verdictIcon(this.states.get(row.path)?.status)}${sourceFileIcon(row.path)}<span class="npm-review-filename" data-tooltip-truncated data-tooltip=${row.path}>${row.name}</span>
            ${this.states.get(row.path)?.notes ? html`<span class="npm-review-note-dot" aria-label="Has notes">•</span>` : nothing}
            ${this._lineCounts(row.file)}${renderFileChange(row.file)}
          </button>` : html`<button type="button" class="npm-review-tree-directory" style=${`padding-left:${8 + row.depth * 12}px`}
            aria-expanded=${String(row.open)} aria-label=${`${row.path}, ${row.checked} of ${row.total} checked`}
            @click=${() => { const next = new Set(this._expanded); if (next.has(row.path)) next.delete(row.path); else next.add(row.path); this._expanded = next }}>
            <span class=${`npm-review-chevron ${row.open ? 'open' : ''}`}>${NEXT_ICON}</span><span class="npm-review-filename">${row.name}</span>
            <span class="npm-review-directory-count">${row.checked}/${row.total}</span></button>`}
        </li>`)}
      </ul>${rows.length === 0 ? html`<p class="npm-review-empty">No matching files.</p>` : nothing}
      ${rows.length > this._limit ? html`<button type="button" class="npm-review-tree-more" @click=${() => { this._limit += 300 }}>Show more files (${rows.length - this._limit})</button>` : nothing}</div>
      <footer class="npm-review-tree-footer"><span>Checked / total</span><button type="button" ?disabled=${tree.total === tree.checked}
        @click=${() => { const at = this.files.findIndex(file => file.path === this.path);
          const next = this.files.find((file, index) => index > at && !this.states.get(file.path)?.status) ?? this.files.find(file => !this.states.get(file.path)?.status);
          this._query = ''; this._select(next?.path) }}>Next unchecked ${NEXT_ICON}</button></footer>`
  }
}
customElements.define('npm-review-tree', NpmReviewTree)
