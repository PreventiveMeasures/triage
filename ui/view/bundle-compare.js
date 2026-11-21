// `<bundle-compare>` — the Compare slide: picks a bundle to compare the open
// one with and shows what changed, git-style, from the one picked (before)
// to the open one (after): files added, removed and changed, package size
// shifts and the net deltas. Overview lists them; Code
// (bundle-compare-code.js) reviews the files as a diff, a file row opening
// there. The other bundle is parsed on demand, state-free; the selection
// lives here, so a re-render from elsewhere keeps it, and a new base
// (`integrity`) resets it. `request` (`state.bundleCompare`) picks the
// target and mode to start from; the user's picks are reported as
// `bundle-compare-change`.
//
// `source`, when set, offers what to compare with in place of the bundles on
// hand, as an npm version offers its package's others (npm-package.js
// npmCompareSource): `{ noun, base, options, choices, pending, error,
// name(id), load(id), open(base, target, mode), select?(side, label),
// files?, dependencies?(base, other), dependencyTags?,
// openDependency?, badges?(base, other, files), widest }`. Its ids stand
// where integrities do; `options` are what the open one compares with,
// `choices` what may take its place, each `{ id, name, format, detail,
// date?, dateWarning? }`. What `load` reads may name itself otherwise
// (`compareId`, as a branch reads as its head's commit), which then stands
// for it. `dependencies` replaces Packages: `{ removed, added, changed }`
// rows, `{ key, name, kind, range }`, a changed one's `from` and `to`, with
// their `flags` (npm-dependency-checks.js).
//
// Picking the first side compares with it; picking the second opens what
// was picked, compared with the same first side, and picking the first
// side's bundle there swaps the two.
import { LitElement, html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from './style-map.js'
import { rootLabel } from '@preventive/compare/view.js'
import { state } from '#client/index.js'
import { formatBytes, stripCommonPathPrefix } from './format.js'
import { dirClass, formatDelta } from './bundle-compare-stats.js'
import { compareSourceOptions, renderComparisonHeader, renderComparisonPicker, renderComparisonSummary } from './bundle-compare-picker.js'
import { pkgColor } from './graph/utils.js'
import { pkgLabel } from '../../common/bundle-pkg-of.js'
import { buildBundleDetails, takeHandedOffBundle } from './bundle-load.js'
import { bundleComparisonCandidates } from './bundle-comparison-candidates.js'
import { bundleComparison } from './bundle-comparison.js'
import { renameTemplate, rootTemplate, withoutPrefix } from './bundle-compare-rename.js'
import { bundleCompareScopes } from '../../common/bundle-compare-inputs.js'
import './bundle-selector.js'
import './bundle-scope-selector.js'
import './bundle-compare-code.js'
import { fileMetaFlags, fileMetaTags } from './bundle-compare-meta.js'
import { byFlags } from './file-flags.js'
import { renderComparisonViewer } from './bundle-compare-view.js'
import { compareModeOf } from '../../common/managed/routes.js'

// Each import-resolutions table's rendered rows, so a pathological compare
// stamps out no tens of thousands of nodes; the counts stay exact.
const MAX_ROWS = 400
// Widest version column in Removed / Added; a longer list ellipsizes.
const MAX_VERSION_CHARS = 24
// The Overview's column order, Packages and Files alike.
const LANES = ['removed', 'added', 'changed']

// Reopen handoff. A swap, or a pick on this side, navigates to another base
// to compare with a target; this module-level slot carries the target
// across the prop teardown that navigation triggers, a field wouldn't.
// `{ base, target, scope, mode, codePath }`, taken once when the base
// becomes `base`, dropped when another opens. Parsed bundles ride the swap
// event instead (bundle-load.js handOffBundles).
let _pendingSwap = null

class BundleCompare extends LitElement {
  static properties = {
    details: { attribute: false },
    integrity: { attribute: false },
    // `{ bundle, target, mode }`: compare `bundle` (when it's the one open) with `target`, in `mode`.
    request: { attribute: false },
    source: { attribute: false },
    // The one picked to compare with (null: none yet), its parsed details, and their load status.
    _targetIntegrity: { state: true },
    _otherDetails: { state: true },
    _status: { state: true },
    _scope: { state: true },
    _fileSort: { state: true },
    _pkgSort: { state: true },
    // Sections that open on demand (Files, Import resolutions): a large comparison lists thousands of rows.
    _openSections: { state: true },
    // 'overview' | 'code', the file Code shows (null: its first), and a line it is to open at once (_openLine).
    _mode: { state: true },
    _codePath: { state: true },
    _codeSeek: { state: true },
  }

  // Light DOM so report.css applies and file-row clicks reach events.js's delegates.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.details = null
    this.integrity = null
    this.request = null
    this.source = null
    this._targetIntegrity = null
    this._otherDetails = null
    this._status = 'idle'
    this._scope = ''
    this._fileSort = { removed: 'name', added: 'name', changed: 'name' }
    this._pkgSort = { removed: 'size', added: 'size', changed: 'size' }
    this._openSections = new Set()
    this._mode = 'overview'
    this._codePath = null
    this._codeSeek = null
    // Painted again once the pair's comparison comes (bundle-comparison.js).
    this._repaint = () => this.requestUpdate()
    // The body Packages' lists fit, watched for a new width or height.
    this._fitBody = null
    this._fitObserver = null
  }

  connectedCallback() {
    super.connectedCallback()
    if (this._fitBody) this._fitObserver?.observe(this._fitBody)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._fitObserver?.disconnect()
  }

  willUpdate(changed) {
    // A package version's files are what it is: listed open, unlike a
    // bundle's, which can run to thousands.
    if (changed.has('source') && this.source && !changed.get('source')) this._openSections = new Set([...this._openSections, 'files'])
    if ((changed.has('_otherDetails') || changed.has('details')) && this._status === 'ready'
      && !bundleCompareScopes(this._otherDetails, this.details).some(scope => scope.id === this._scope)) this._scope = ''
    // Reset only when the base's integrity changes: new details for the same
    // one (its parse landing, fileHashes attaching) are the same content.
    if (changed.has('integrity')) this._rebase()
    // A link's target and mode, idle when already shown; one withdrawn (a
    // bare Compare route) takes the comparison with it.
    if ((changed.has('request') || changed.has('integrity')) && this.integrity && this.request?.bundle === this.integrity) {
      if (this.request.target !== this._targetIntegrity) this._choose(this.request.target)
      this._mode = compareModeOf(this.request.mode)
    } else if (changed.has('request') && !changed.has('integrity') && changed.get('request')?.bundle === this.integrity) {
      if (this._targetIntegrity) this._choose(null)
      this._mode = 'overview'
    }
  }

  updated() {
    // Code renders no body, and leaving it renders a new one.
    const body = this.querySelector('.bundle-compare-body')
    if (body !== this._fitBody && typeof ResizeObserver === 'function') {
      this._fitObserver ??= new ResizeObserver(() => this._fitLists())
      this._fitObserver.disconnect()
      if (body) this._fitObserver.observe(body)
      this._fitBody = body
    }
    this._fitLists()
  }

  // Packages' lists take the pane but for what sits around them, which CSS
  // can't add up: measured here as `--compare-fill-around` (the heads above,
  // the card's foot and every section after as it sits closed, with margins).
  // The last block's lists in their last row run on to the pane's foot
  // (`--compare-rest`). Neither moves with the list's own height, so setting
  // them settles at once.
  _fitLists() {
    const body = this._fitBody
    if (!body) return
    const style = getComputedStyle(body)
    const content = body.getBoundingClientRect().top + body.clientTop + parseFloat(style.paddingTop) - body.scrollTop
    // From the pane's top to a list's, and its card's foot under it.
    const around = list => {
      const box = list.getBoundingClientRect()
      return box.top - content + list.parentElement.getBoundingClientRect().bottom - box.bottom
    }
    const fill = body.querySelector('.bundle-compare-rows--fill')
    if (fill) {
      let space = around(fill)
      const section = fill.closest('.bundle-compare-section')
      for (let el = section; el; el = el.nextElementSibling) {
        // An open one to its heading's margin, as it sits closed.
        const heading = el.matches('details[open]') && el.querySelector(':scope > summary')
        const closed = el === section ? 0 : heading
          ? heading.getBoundingClientRect().bottom + parseFloat(getComputedStyle(heading).marginBottom) - el.getBoundingClientRect().top
          : el.getBoundingClientRect().height
        space += closed + parseFloat(getComputedStyle(el).marginBottom)
      }
      body.style.setProperty('--compare-fill-around', `${space}px`)
    }
    const lists = [...body.querySelectorAll('.bundle-compare-rows--scroll:not(.bundle-compare-rows--fill)')]
    if (lists.length === 0) return
    const last = body.lastElementChild
    const tops = new Map(lists.filter(list => last.contains(list)).map(list => [list, list.parentElement.getBoundingClientRect().top]))
    const lastRow = Math.max(...tops.values())
    const pane = body.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    const margin = parseFloat(getComputedStyle(last).marginBottom)
    for (const list of lists) {
      if (tops.get(list) >= lastRow - 1) list.style.setProperty('--compare-rest', `${pane - around(list) - margin}px`)
      else list.style.removeProperty('--compare-rest')
    }
  }

  // The base changed: compare it afresh, or, opened by a swap or a pick here
  // (_pendingSwap), with the target it was opened to compare with.
  _rebase() {
    const base = this._baseKey
    const swap = base && _pendingSwap?.base === base ? _pendingSwap : null
    if (base) _pendingSwap = null
    if (swap) this._mode = swap.mode
    this._scope = swap ? swap.scope : ''
    this._codePath = swap ? swap.codePath : null
    const target = swap?.target || null
    this._targetIntegrity = target
    // The old base is still parsed: compared with as it stands.
    const handed = target && !this.source ? takeHandedOffBundle(target, details => Boolean(details.json || details.bundle)) : null
    this._otherDetails = handed
    this._status = handed ? 'ready' : target ? 'loading' : 'idle'
    if (target && !handed) this._loadOther(target)
  }

  // The id this side is picked by: its integrity, or its source's id.
  get _baseKey() {
    return this.source ? this.source.base : this.integrity
  }

  // Open the target as the base, compared with the old base.
  _swap() {
    const target = this._targetIntegrity
    if (target && target !== this._baseKey) this._reopen(target, this._baseKey)
  }

  // A pick on this side: open it compared with the same target, or swap where it is the target.
  _pickBase(value) {
    if (!value || value === this._baseKey) return
    if (value === this._targetIntegrity) this._swap()
    else this._reopen(value, this._targetIntegrity)
  }

  // Open `base`, compared with `target` (null: nothing picked yet): a source
  // opens its own; else events.js switches bundles off `bundle-swap`, what is
  // parsed of either side handed to its new role rather than parsed again.
  _reopen(base, target) {
    if (!this.source && !bundleComparisonCandidates(state.bundles ?? [], this.integrity).some(b => b.integrity === base)) return
    _pendingSwap = { base, target, scope: this._scope, mode: this._mode, codePath: this._codePath }
    if (this.source) {
      this.source.open(base, target, this._mode)
      return
    }
    const parsed = details => details && !details.error && (details.json || details.bundle) && [base, target].includes(details.integrity)
    const bundles = [this._otherDetails, this._baseReady ? this.details : null].filter(parsed)
    this.dispatchEvent(new CustomEvent('bundle-swap', {
      bubbles: true,
      composed: true,
      detail: { integrity: base, target, bundles, mode: this._mode },
    }))
  }

  // A bundle's name from the sidebar's list, else a short integrity prefix (deleted meanwhile).
  _nameFor(integrity) {
    if (this.source) return this.source.name(integrity)
    const entry = (state.bundles ?? []).find((b) => b.integrity === integrity)
    return entry?.name ?? `${integrity.slice(0, 'sha512-'.length + 8)}…`
  }

  // Picker change, reported.
  _pick(value) {
    this._choose(value)
    this._notify()
  }

  // The user's comparison, for a managed bundle's URL (events.js).
  _notify() {
    this.dispatchEvent(new CustomEvent('bundle-compare-change', {
      bubbles: true,
      composed: true,
      detail: { base: this.integrity, target: this._targetIntegrity, mode: this._mode },
    }))
  }

  // Empty clears the comparison; else the chosen one is parsed, the last
  // dropped at once so no stale diff lingers under the spinner.
  _choose(value) {
    const integrity = value || null
    this._targetIntegrity = integrity
    this._otherDetails = null
    this._codePath = null
    if (!integrity) { this._status = 'idle'; this._scope = ''; return }
    this._status = 'loading'
    this._loadOther(integrity)
  }

  async _loadOther(integrity) {
    const entry = this.source ? null : bundleComparisonCandidates(state.bundles ?? [], this.integrity).find(b => b.integrity === integrity)
    if (!this.source && !entry) { this._status = 'idle'; this._targetIntegrity = null; this._notify(); return }
    let details
    try { details = await (this.source ? this.source.load(integrity) : buildBundleDetails(integrity, entry)) }
    catch (err) {
      if (err.name === 'AbortError') return
      if (!this.source) throw err
      details = { error: err.message }
    }
    // A stale answer, for a pick (or a base) that no longer stands, is dropped.
    if (this._targetIntegrity !== integrity) return
    this._otherDetails = details
    this._status = 'ready'
    if (this.source && details?.compareId && details.compareId !== integrity) {
      this._targetIntegrity = details.compareId
      this._notify()
    }
  }

  // Once the open bundle is parsed and is the one handed, not the one before.
  get _baseReady() {
    return Boolean(this.details && this.details.integrity === this.integrity && (this.details.json || this.details.bundle))
  }

  // Review a file's changes in the Code view.
  _openFile(path) {
    this._codePath = path
    this._mode = 'code'
    this._notify()
  }

  // Review them at a line of the open version's file (`line` from 1, as a
  // source's badges name it): Code seeks it as a search hit, a new object
  // each time, so the same line asked again is sought again.
  _openLine({ path, line, query }) {
    this._codeSeek = { path, line: line - 1, query }
    this._openFile(path)
  }

  // A card per file / package group: its kind-tinted head with its exact
  // count, every row in a list that scrolls (as tall as the pane allows with
  // `fill`), in its kind's lane of `lanes` (_cols); nothing for an empty group.
  _group(title, rows, kind, keyOf, rowOf, actions = nothing, { fill = false, lanes = LANES, style = {} } = {}) {
    if (rows.length === 0) return nothing
    return html`<section class=${`bundle-compare-group bundle-compare-${kind}`} style=${styleMap({ '--compare-lane': String(lanes.indexOf(kind) + 1), ...style })}>
      <header class="bundle-compare-group-head">
        <span class="bundle-compare-dot" aria-hidden="true"></span>
        <span class="bundle-compare-group-title" data-tooltip-truncated data-tooltip=${title}>${title}</span>
        <span class="bundle-compare-group-count">${rows.length}</span>
        ${actions}
      </header>
      <ul class=${fill ? 'bundle-compare-rows bundle-compare-rows--scroll bundle-compare-rows--fill' : 'bundle-compare-rows bundle-compare-rows--scroll'}>
        ${repeat(rows, keyOf, rowOf)}
      </ul>
    </section>`
  }

  // A row's size, or for a changed one its signed delta, `base → other` (and
  // lines of code) in its tooltip; a dash for a size it hasn't.
  _sizeCells(r) {
    const bytes = value => value == null ? '—' : formatBytes(value)
    const loc = count => `${count.toLocaleString()} LoC`
    return r.delta === undefined
      ? html`<span class="bundle-compare-row-size" data-tooltip=${r.lines > 0 ? loc(r.lines) : nothing}>${bytes(r.bytes)}</span>`
      : html`<span class=${`bundle-compare-row-delta ${r.delta === null ? '' : dirClass(r.delta)}`}
          data-tooltip=${`${bytes(r.baseBytes)} → ${bytes(r.otherBytes)}${r.baseLines > 0 || r.otherLines > 0 ? ` · ${r.baseLines.toLocaleString()} → ${loc(r.otherLines)}` : ''}`}>${r.delta === null ? '—' : formatDelta(r.delta)}</span>`
  }

  // Name | Size (| Flags) order for one group, kept per kind in `field`; `sort` the one it is in.
  _sortActions(field, kind, label, flagged = false, sort = this[field][kind]) {
    return html`<span class="bundles-overview-sort" role="group" aria-label=${`${kind} ${label} order`}>
      ${[['name', 'Name'], ['size', 'Size'], ...flagged ? [['flags', 'Flags']] : []].map(([value, text]) => html`<button type="button" aria-pressed=${String(sort === value)}
        @click=${() => { this[field] = { ...this[field], [kind]: value } }}>${text}</button>`)}
    </span>`
  }

  // One file group, every row listed. Size order is the largest first (for
  // Changed the largest change), name order breaking ties; Flags order
  // (file-flags.js byFlags) is offered where any row is flagged, as a
  // source's `files.flags` or a stasis bundle's record flags it.
  _fileGroup(title, rows, kind, displayOf, lanes) {
    const files = this.source?.files, tagged = kind !== 'removed'
    // A file as the version compared with has it, for what its tags say is new to it.
    const base = r => kind === 'added' ? null : { details: this._otherDetails, path: r.basePath ?? r.path }
    const flagsOf = r => [...tagged && files?.flags ? files.flags(this.details, r.path, base(r)) : [], ...fileMetaFlags(r.meta)]
    const flagged = rows.some(r => flagsOf(r).length > 0)
    const sort = this._fileSort[kind] === 'flags' && !flagged ? 'name' : this._fileSort[kind]
    const weight = r => kind === 'changed' ? Math.abs(r.delta) : r.bytes
    const sorted = sort === 'flags' ? byFlags(rows, flagsOf, r => r.path)
      : rows.toSorted((a, b) => (sort === 'size' ? weight(b) - weight(a) : 0) || a.path.localeCompare(b.path))
    // A file's type icon from each side under its own path, and its tags where the open one has it.
    const row = r => html`<li><button type="button" class="bundle-compare-row bundle-compare-row-link" @click=${() => this._openFile(r.path)}>
      ${files ? files.icon(r.path, [[this._otherDetails, r.basePath ?? r.path], [this.details, r.path]]) : nothing}<span class="bundle-compare-row-path mono" data-tooltip-truncated
        data-tooltip=${r.renamedFrom == null ? r.path : `${r.renamedFrom} → ${r.path}`}>${r.renamedFrom == null ? displayOf(r.path)
        : renameTemplate(displayOf(r.renamedFrom), displayOf(r.path))}</span>${tagged ? files?.tag?.(this.details, r.path, base(r)) ?? nothing : nothing}${fileMetaTags(r.meta)}${this._sizeCells(r)}
    </button></li>`
    return this._group(title, sorted, kind, r => r.path, row, this._sortActions('_fileSort', kind, 'file', flagged, sort), { lanes })
  }

  // One package group, each with its versions and size, its package's color
  // dot as the treemap's. Removed / Added size their version column to the
  // longest list, so versions and sizes line up row to row.
  _pkgGroup(title, rows, kind, lanes) {
    const sort = this._pkgSort[kind]
    // A side without a size sorts last.
    const weight = r => { const value = kind === 'changed' ? r.delta : r.bytes; return value == null ? -1 : Math.abs(value) }
    const sorted = rows.toSorted((a, b) => (sort === 'size' ? weight(b) - weight(a) : 0) || pkgLabel(a.pkg).localeCompare(pkgLabel(b.pkg)))
    const versionChars = kind === 'changed' ? 0 : Math.min(MAX_VERSION_CHARS, Math.max(0, ...rows.map(r => r.versions.join(', ').length)))
    return this._group(title, sorted, kind, r => r.pkg, r => html`<li><div class="bundle-compare-row">
      <span class="bundle-compare-pkg-dot" style=${styleMap({ background: pkgColor(r.pkg) })}></span>
      <span class="bundle-compare-row-path" data-tooltip-truncated data-tooltip=${pkgLabel(r.pkg)}>${pkgLabel(r.pkg)}</span>
      ${kind === 'changed' ? this._versionCell(r) : versionChars > 0 ? html`<span class="bundle-compare-dep-ver" data-tooltip-truncated data-tooltip=${r.versions.join(', ')}>${r.versions.join(', ')}</span>` : nothing}
      ${this._sizeCells(kind === 'changed' ? r : { bytes: r.bytes })}
    </div></li>`, this._sortActions('_pkgSort', kind, 'package'),
    { fill: true, lanes, style: versionChars > 0 ? { '--compare-version-width': `${versionChars}ch` } : {} })
  }

  // A changed package's versions, `old → new`, the new side and a glyph
  // colored by direction, spelled out for screen readers; the one list when
  // only its size moved; nothing for one without versions.
  _versionCell(r) {
    const after = r.otherVersions.join(', '), before = r.baseVersions.join(', ')
    if (r.baseVersions.join() === r.otherVersions.join()) return r.baseVersions.length > 0 ? html`<span class="bundle-compare-dep-ver">${before}</span>` : nothing
    const direction = r.direction ?? 'changed'
    const [glyph, word] = direction === 'up' ? ['↑', 'Upgraded'] : direction === 'down' ? ['↓', 'Downgraded'] : ['±', 'Changed']
    return html`<span class="bundle-compare-ver" aria-label=${`${word}: ${before || 'none'} to ${after || 'none'}`}>
      <span class="bundle-compare-ver-from">${before || '—'}</span>
      <span class="bundle-compare-ver-arrow" aria-hidden="true">→</span>
      <span class=${`bundle-compare-ver-to ${direction}`}>${after || '—'}</span>
      <span class=${`bundle-compare-ver-dir ${direction}`} aria-hidden="true">${glyph}</span>
    </span>`
  }

  // A source's dependencies: the range each requires, or for Changed the
  // one it moved from and to, its kind (peer, optional) and the source's tags.
  _depGroup(title, rows, kind, lanes) {
    const rangeChars = kind === 'changed' ? 0 : Math.min(MAX_VERSION_CHARS, Math.max(0, ...rows.map(r => r.range.length)))
    const cells = r => html`<span class="bundle-compare-row-path" data-tooltip-truncated data-tooltip=${r.name}>${r.name}</span>
      ${this.source?.dependencyTags?.(r, kind) ?? nothing}${r.kind ? html`<span class="npm-dependency-kind">${r.kind}</span>` : nothing}
      ${kind === 'changed' ? html`<span class="bundle-compare-ver" aria-label=${`Changed: ${r.from} to ${r.to}`}>
          <span class="bundle-compare-ver-from">${r.from}</span>
          <span class="bundle-compare-ver-arrow" aria-hidden="true">→</span>
          <span class="bundle-compare-ver-to changed">${r.to}</span>
        </span>`
        : html`<span class="bundle-compare-dep-ver" data-tooltip-truncated data-tooltip=${r.range}>${r.range}</span>`}`
    // One the source can open (`openDependency`), it opens.
    const open = this.source?.openDependency
    return this._group(title, rows, kind, r => r.key, r => html`<li>${open && r.opens
      ? html`<button type="button" class="bundle-compare-row bundle-compare-row-link" @click=${() => open(r)}>${cells(r)}</button>`
      : html`<div class="bundle-compare-row">${cells(r)}</div>`}</li>`, nothing, { fill: true, lanes, style: rangeChars > 0 ? { '--compare-version-width': `${rangeChars}ch` } : {} })
  }

  _renderDependencies(rows, baseName, otherName, lanes) {
    if (lanes.length === 0) return nothing
    return html`<section class="bundle-compare-section">
      <h3 class="bundle-compare-section-head">Dependencies</h3>
      ${this._cols(lanes, (...group) => this._depGroup(...group), rows, baseName, otherName, 'dependencies')}
    </section>`
  }

  // Packages: each package once, from its files' sizes and the versions each bundle records.
  _renderPackages(rows, baseName, otherName, lanes = LANES) {
    if (rows.removed.length === 0 && rows.added.length === 0 && rows.changed.length === 0) return nothing
    return html`<section class="bundle-compare-section">
      <h3 class="bundle-compare-section-head">Packages</h3>
      ${this._cols(lanes, (...group) => this._pkgGroup(...group), rows, baseName, otherName, 'packages')}
    </section>`
  }

  // Removed | Added | Changed columns of `rows`' groups, each drawn by
  // `group`, one lane per kind in `lanes` (Changed's the widest); Files
  // takes Packages' lanes where it can (_renderDiff). `section` names whose
  // lanes they are, for the stylesheet.
  _cols(lanes, group, rows, baseName, otherName, section) {
    const template = lanes.map(kind => kind === 'changed' ? 'minmax(0, 5fr)' : 'minmax(0, 4fr)').join(' ')
    return html`<div class="bundle-compare-cols" data-lanes=${lanes.length} data-section=${section} style=${styleMap({ '--compare-lanes': template })}>
        ${group(`Removed · only in ${baseName}`, rows.removed, 'removed', lanes)}
        ${group(`Added · only in ${otherName}`, rows.added, 'added', lanes)}
        ${group('Changed', rows.changed, 'changed', lanes)}</div>`
  }

  // A section that opens on demand, its contents drawn only while open. A
  // click on its heading opens it through the render, contents and all (left
  // to the browser, it opened a frame before them); a toggle the browser
  // makes itself (find in page) still lands.
  _collapsible(id, title, count, content, note = '') {
    const open = this._openSections.has(id)
    return html`<details class="bundle-compare-section bundle-compare-collapsible" .open=${live(open)}
      @toggle=${event => this._setSection(id, event.currentTarget.open)}>
      <summary class="bundle-compare-section-head" @click=${event => { event.preventDefault(); this._setSection(id, !open) }}>${title} <span class="bundle-compare-section-count">${count.toLocaleString()}</span>${note ? html`<span class="bundle-compare-section-note" data-tooltip-truncated data-tooltip=${note}>${note}</span>` : nothing}</summary>
      ${open ? content() : nothing}
    </details>`
  }

  _setSection(id, open) {
    if (open === this._openSections.has(id)) return
    const sections = new Set(this._openSections)
    if (open) sections.add(id)
    else sections.delete(id)
    this._openSections = sections
  }

  // Import resolutions as tables, File | Import | Before | After |
  // Conditions, in cards like the groups': those one side records alone,
  // then those repointed; a file opens in Code. Conditions drops out where
  // every row reads `*`.
  _renderResolutions(resolutions, baseName, otherName) {
    if (resolutions.totalChanges === 0) return nothing
    const groups = [
      { title: `Removed · only in ${baseName}`, rows: resolutions.onlyBase, kind: 'removed' },
      { title: `Added · only in ${otherName}`, rows: resolutions.onlyOther, kind: 'added' },
      { title: 'Repointed', rows: resolutions.changed, kind: 'changed' },
    ].filter(({ rows }) => rows.length > 0).map(group => ({ ...group, shown: group.rows.slice(0, MAX_ROWS) }))
    const cell = (text, className = '') => html`<td class=${className}><code data-tooltip-truncated data-tooltip=${text}>${text}</code></td>`
    const target = (text, className) => text === null ? html`<td class="bundle-compare-resolution-none"><span>(none)</span></td>` : cell(text || '(empty target)', className)
    const contextOf = r => `${r.conditions}${r.platform === null ? '' : ` · Platform: ${r.platform}`}`
    // `*` (any conditions, every platform) on every row tells nothing apart.
    const showContext = groups.some(({ shown }) => shown.some(r => contextOf(r) !== '*'))
    return this._collapsible('resolutions', 'Import resolutions', resolutions.totalChanges, () => groups.map(({ title, rows, kind, shown }) => html`
      <section class=${`bundle-compare-group bundle-compare-${kind} bundle-compare-resolutions`}>
        <header class="bundle-compare-group-head">
          <span class="bundle-compare-dot" aria-hidden="true"></span>
          <span class="bundle-compare-group-title">${title}</span>
          <span class="bundle-compare-group-count">${rows.length}</span>
        </header>
        <table class=${showContext ? '' : 'bundle-compare-resolutions--no-context'}>
          <thead><tr><th>File</th><th>Import</th><th>Before</th><th>After</th>${showContext ? html`<th>Conditions</th>` : nothing}</tr></thead>
          <tbody>${repeat(shown, r => r.key, r => {
            const context = contextOf(r)
            return html`<tr>
              <td><button type="button" class="bundle-compare-resolution-parent" data-tooltip-truncated data-tooltip=${r.parent} @click=${() => this._openFile(r.parent)}>${r.parent}</button></td>
              ${cell(r.specifier)}
              ${target(r.baseTarget, 'bundle-compare-resolution-before')}
              ${target(r.otherTarget, 'bundle-compare-resolution-after')}
              ${showContext ? html`<td class="bundle-compare-resolution-context"><span data-tooltip-truncated data-tooltip=${context}>${context}</span></td>` : nothing}
            </tr>`
          })}</tbody>
        </table>
        ${rows.length > shown.length ? html`<div class="bundle-compare-more">and ${(rows.length - shown.length).toLocaleString()} more…</div>` : nothing}
      </section>`))
  }

  // The pairing's comparison: loading, ready with its `diff`, or failed.
  _comparison() {
    return bundleComparison(this._otherDetails, this.details, this._scope, this._repaint)
  }

  // The summary band under the picker, the mode tabs at its end.
  _renderSummary(diff) {
    return renderComparisonSummary(diff, html`<div class="bundle-compare-modes" role="tablist" aria-label="Comparison view">
      ${[['overview', 'Overview'], ['code', 'Code']].map(([mode, label]) => html`<button type="button" role="tab"
        aria-selected=${String(this._mode === mode)} @click=${() => { this._mode = mode; this._notify() }}>${label}</button>`)}
    </div>`)
  }

  _renderPicker(others, hasTarget, scopeSelector, comparison) {
    return renderComparisonPicker({ source: this.source,
      from: { options: others, value: this._targetIntegrity, pick: value => this._pick(value) },
      to: { options: this._baseOptions(), value: this._baseKey, placeholder: this._nameFor(this.integrity), pick: value => this._pickBase(value) },
      clear: hasTarget ? { run: () => this._pick(null) } : null,
      swap: hasTarget ? () => this._swap() : null,
      extras: scopeSelector, comparison, openLine: detail => this._openLine(detail),
    })
  }

  // What this side may become: the open bundle and those it compares with, or a source's choices.
  _baseOptions() {
    if (this.source) return compareSourceOptions(this.source.choices ?? [])
    const base = (state.bundles ?? []).find(bundle => bundle.integrity === this.integrity)
    const others = bundleComparisonCandidates(state.bundles ?? [], this.integrity)
    return this._bundleOptions(base ? [base, ...others] : others)
  }

  _otherOptions() {
    if (this.source) return compareSourceOptions(this.source.options)
    return this._bundleOptions(bundleComparisonCandidates(state.bundles ?? [], this.integrity))
  }

  // Bundles as picker options, same-named ones told apart by a short integrity suffix.
  _bundleOptions(others) {
    const nameCounts = new Map()
    for (const b of others) nameCounts.set(b.name, (nameCounts.get(b.name) ?? 0) + 1)
    return others.map((b) => ({
      id: b.integrity, integrity: b.integrity,
      kind: b.kind ?? (b.name.toLowerCase().endsWith('.map') ? 'sourcemap' : 'stasis'),
      summary: b.summary,
      size: typeof b.size === 'number' ? formatBytes(b.size) : '—',
      filename: nameCounts.get(b.name) > 1
        ? `${b.name} · ${b.integrity.slice('sha512-'.length, 'sha512-'.length + 6)}…`
        : b.name,
    }))
  }

  render() {
    const others = this._otherOptions()
    // A picked bundle deleted meanwhile is no target; a source's stands while
    // its options list, its load telling whether it exists.
    const hasTarget = Boolean(this._targetIntegrity)
      && (Boolean(this.source) || others.some((o) => o.integrity === this._targetIntegrity))
    const scopes = this._baseReady ? bundleCompareScopes(hasTarget ? this._otherDetails : null, this.details) : []
    const scopeSelector = scopes.length > 0
      ? html`<bundle-scope-selector .reasons=${scopes} .value=${this._scope} label="Compare scope" @scope-change=${event => { this._scope = event.detail.value }}></bundle-scope-selector>`
      : nothing
    const ready = hasTarget && this._status === 'ready' && this._otherDetails && (this._otherDetails.json || this._otherDetails.bundle) && !this._otherDetails.error
    const paired = this._baseReady && ready ? this._comparison() : null
    const diff = paired?.status === 'ready' ? paired.diff : null
    const comparison = diff ? { base: this._otherDetails, other: this.details, files: diff.files } : null
    // The picker is there whenever there is anything to pick, so the head is
    // one row before a pick and two (picker, summary) after.
    const picker = others.length > 0 || this.source ? this._renderPicker(others, hasTarget, scopeSelector, comparison) : scopeSelector
    const mode = diff ? this._mode : 'overview'
    return html`<div class="bundle-compare">
      ${renderComparisonHeader(picker, diff ? this._renderSummary(diff) : nothing)}
      ${mode === 'code' ? renderComparisonViewer({ base: this._otherDetails, other: this.details, diff, source: this.source,
        path: this._codePath, seek: this._codeSeek, baseName: this._nameFor(this._targetIntegrity), otherName: this._nameFor(this.integrity), select: path => { this._codePath = path },
      })
        : html`<div class="bundle-compare-body">${diff ? this._renderDiff(diff) : this._empty(others, hasTarget, paired)}</div>`}
    </div>`
  }

  // What the body says while there is no comparison to show.
  _empty(others, hasTarget, paired) {
    const name = html`<strong>${this._nameFor(this.integrity)}</strong>`, noun = this.source?.noun ?? 'bundle'
    const empty = (content, error = false) => html`<div class=${error ? 'bundle-compare-empty is-error' : 'bundle-compare-empty'}>${content}</div>`
    if (!this._baseReady) return empty('Loading bundle…')
    if (this.source && !hasTarget && (this.source.pending || this.source.error || (!this.source.select && others.length === 0))) {
      return empty(this.source.pending ? `Loading ${noun}s…` : this.source.error ?? html`No other ${noun}s to compare ${name} with.`, Boolean(this.source.error))
    }
    if (others.length === 0 && !this.source) {
      return empty(html`No other bundles to compare with. Drop a second <code>.map</code> or <code>.stasis.code.br</code> bundle to diff against this one.`)
    }
    if (!hasTarget) return empty(html`Pick a ${noun} above to compare ${name} against.`)
    if (this._status === 'loading' || !this._otherDetails) return empty('Comparing…')
    if (this._otherDetails.error) return empty(`Couldn't read the selected ${noun}: ${this._otherDetails.error}`, true)
    if (!this._otherDetails.json && !this._otherDetails.bundle) return empty(`The selected ${noun} couldn't be parsed.`, true)
    if (paired?.status === 'error') return empty(`Couldn't compare the ${noun}s: ${paired.message}`, true)
    return empty('Comparing…')
  }

  _renderDiff(diff) {
    // From the one picked to the open one.
    const baseName = this._nameFor(this._targetIntegrity)
    const otherName = this._nameFor(this.integrity)
    // Display paths drop the root shared by everything listed; where the
    // bundles' roots differ, the heading reads the move at the root.
    const allPaths = [
      ...diff.files.onlyBase.map((r) => r.path),
      ...diff.files.onlyOther.map((r) => r.path),
      ...diff.files.changed.flatMap((r) => r.renamedFrom == null ? [r.path] : [r.path, r.renamedFrom]),
    ]
    const root = rootLabel(diff.files.root, stripCommonPathPrefix(allPaths).prefix)
    const { prefix } = root
    const displayOf = p => withoutPrefix(p, prefix)
    const files = { removed: diff.files.onlyBase, added: diff.files.onlyOther, changed: diff.files.changed }
    const fileCount = files.removed.length + files.added.length + files.changed.length
    const listsFiles = !diff.totals.identical
    // Files line up under Packages (or a source's own dependencies) while
    // that has a lane for each kind Files lists; else each lays out its own.
    const dependencies = this.source?.dependencies?.(this._otherDetails, this.details) ?? null
    const packageLanes = LANES.filter(kind => (dependencies ?? diff.packageRows)[kind].length > 0)
    const fileKinds = listsFiles ? LANES.filter(kind => files[kind].length > 0) : []
    const fileLanes = fileKinds.every(kind => packageLanes.includes(kind)) ? packageLanes : fileKinds
    // Over the files, a source's warning on those the open one adds or changes.
    const warning = listsFiles ? this.source?.files?.warning?.(this.details, [...files.added, ...files.changed].map(r => r.path)) : nothing
    return html`
      ${dependencies ? this._renderDependencies(dependencies, baseName, otherName, packageLanes)
        : this._renderPackages(diff.packageRows, baseName, otherName, packageLanes)}
      ${warning ?? nothing}
      ${diff.totals.identical
        ? diff.resolutions.totalChanges > 0
          ? html`<div class="bundle-compare-caption">File contents are unchanged; import resolutions differ.</div>`
          : html`<div class="bundle-compare-identical">These two ${this.source?.noun ?? 'bundle'}s carry identical files (${diff.totals.unchangedFiles.toLocaleString()} ${diff.totals.unchangedFiles === 1 ? 'file' : 'files'})${root.from ? html`, moved <span class="mono">${rootTemplate(root)}</span>` : ''}.</div>`
        : this._collapsible('files', 'Files', fileCount, () => this._cols(fileLanes, (title, rows, kind, lanes) => this._fileGroup(title, rows, kind, displayOf, lanes),
          files, baseName, otherName, 'files'), root.from ? `${root.from} → ${root.to}` : prefix)}
      ${this._renderResolutions(diff.resolutions, baseName, otherName)}
    `
  }
}

customElements.define('bundle-compare', BundleCompare)
