// `<bundle-compare>` — the Compare slide in the bundles view. Picks a
// second bundle and diffs it against the currently-open one: which
// files — source and resources alike, the files the Overview lists —
// were added / removed / changed, the per-package size shifts, and the
// net byte/file delta. The headline use case is two
// builds of the same artifact ("what did this dependency bump pull
// in?"), but it works on any two bundles the user has on disk.
//
// Two modes share the summary row's tabs: Overview (the default) lists what
// changed, and Code (bundle-compare-code.js) reviews the files that differ
// as a diff. A file row in the Overview opens that file in Code.
//
// The comparison is framed git-style: the open bundle is the "base"
// (before), the picked bundle is "other" (after), and added / removed
// / changed read relative to base. The header spells out the
// direction so the coloring isn't ambiguous.
//
// `details` is the parsed open bundle (from `state.bundleDetails`);
// the other bundle is parsed on demand via `buildBundleDetails`
// (state-free — it doesn't touch `state.bundleDetails`). Selection +
// the parsed other-bundle live in component-internal state, mirroring
// how the treemap owns its drill-in: a re-render from elsewhere (the
// finding-index subscription) keeps the element mounted and so keeps
// the comparison; switching the base bundle resets it via willUpdate.
// `request` (`state.bundleCompare`, from a managed link) picks the bundle
// and mode to start from; a pick, clear, or mode switch the user makes
// is reported as `bundle-compare-change`, which keeps a managed URL on it.
// `source`, when set, offers what to compare with in place of the bundles
// on hand, as an npm package version offers the package's other versions
// (npm-package.js npmCompareSource): `{ noun, base, options, choices,
// pending, error, name(id), load(id), open(base, target, mode),
// dependencies(base, other) }`, each option `{ id, name, format, detail }`;
// its ids stand where bundles' integrities do, `base` the open one's.
// `options` are what the open one compares with, `choices` what may take
// its place.
//
// Both sides are pickers. Picking the other side compares with it; picking
// this side opens what was picked, compared with the same other side, and
// picking the other side's bundle there swaps the two. `dependencies` lists what replaces Packages: removed,
// added and changed rows, `{ key, name, kind, range }` or, changed, with
// `from` and `to` in place of `range`.
import { LitElement, html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from 'lit/directives/style-map.js'
import { state } from '#client/index.js'
import { formatBytes, stripCommonPathPrefix } from './format.js'
import { pkgColor } from './graph/utils.js'
import { bundlePkgOf, pkgLabel } from './bundle-pkg-of.js'
import { bundlePackageDirs, bundlePackageVersions } from './bundle-sources.js'
import { buildBundleDetails, takeHandedOffBundle } from './bundle-load.js'
import { bundleComparisonCandidates } from './bundle-comparison-candidates.js'
import { comparePackages, computeBundleDiff, computeResolutionDiff, computeVersionUpdates } from './bundle-compare-diff.js'
import { renameTemplate } from './bundle-compare-rename.js'
import { bundleCompareFiles, bundleCompareResolutions, bundleCompareScopes } from './bundle-compare-inputs.js'
import './bundle-selector.js'
import './bundle-scope-selector.js'
import './bundle-compare-code.js'
import { COMBINED_DIFF_MAX, combinedDiffRows } from './bundle-compare-all.js'
import { compareModeOf } from '../../common/managed/routes.js'

// Cap the repointed-imports table's rendered rows so a pathological
// compare can't stamp out tens of thousands of DOM nodes. The counts are
// always exact; only the listing is trimmed, with an "and N more" footer.
// (File and package groups list every row in a scrolling list instead.)
const MAX_ROWS = 400
// Widest version column in Removed / Added; a longer list ellipsizes.
const MAX_VERSION_CHARS = 24
// The Overview's column order, Packages and Files alike.
const LANES = ['removed', 'added', 'changed']

// Reopen handoff. Swap, or a pick on this side, opens another bundle (the
// app navigates to it) to compare with a target. That base change would
// normally clear the comparison in willUpdate; this module-level slot
// carries the intended target across the prop teardown — a
// component-internal field wouldn't survive the navigation. Shape:
// `{ base, target, scope, mode, codePath }`, `base` the opened one's
// integrity, or a source's id, consumed once by willUpdate when the base
// becomes it, or dropped when another bundle opens. It holds no parsed
// bundle: those ride the swap event to the navigation, which hands them
// over (bundle-load.js handOffBundles) for as long as it runs.
let _pendingSwap = null

// Signed count for a summary metric delta: `+3` / `−2` / `±0`. Uses a
// real minus (−) to match the typographic style elsewhere in the
// chrome and so it never reads as a hyphen in a path. Used by the
// Files and Deps metrics.
function formatCountDelta(n) {
  if (n === 0) return '±0'
  return `${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString()}`
}

// Signed byte size for a delta cell, sized like the totals beside it:
// `+1.2 KiB` / `−340 B` / `±0 B`.
function formatDelta(n) {
  if (n === 0) return '±0 B'
  return `${n > 0 ? '+' : '−'}${formatBytes(Math.abs(n))}`
}

// CSS direction suffix for a signed number: 'up' (green) / 'down'
// (red) / '' (neutral). Shared by the summary metric deltas and the
// per-row size deltas.
function dirClass(n) {
  return n > 0 ? 'up' : n < 0 ? 'down' : ''
}

// Percent change of a byte delta against the base total. Empty when
// the base is zero (every byte is new, so a percentage is meaningless).
function formatPct(delta, baseBytes) {
  if (!baseBytes) return ''
  const pct = (delta / baseBytes) * 100
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±'
  return `${sign}${Math.abs(pct).toFixed(1)}%`
}

// A dependency's version list, comma-joined — usually one entry, more
// when pnpm kept duplicate majors side by side.
function versionList(versions) {
  return versions.join(', ')
}

class BundleCompare extends LitElement {
  static properties = {
    details: { attribute: false },
    integrity: { attribute: false },
    // `{ bundle, target, mode }`: compare `bundle` (when it's the one open)
    // with `target`, in `mode`.
    request: { attribute: false },
    source: { attribute: false },
    // Integrity of the bundle picked to compare against (null = none
    // chosen yet), the parsed bytes of that bundle once loaded, and a
    // coarse load status the body switches on.
    _targetIntegrity: { state: true },
    _otherDetails: { state: true },
    _status: { state: true },
    _scope: { state: true },
    _fileSort: { state: true },
    _pkgSort: { state: true },
    // Sections that open on demand (Files, Import resolutions): a large
    // comparison lists thousands of rows.
    _openSections: { state: true },
    // 'overview' | 'code' | 'diff' (COMPARE_MODES), and the file the Code
    // view shows (null: its first changed file).
    _mode: { state: true },
    _codePath: { state: true },
  }

  // Light DOM so report.css applies + file-row clicks bubble to the
  // document-level [data-bundle-view-source] delegate in events.js.
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
    // Diff memo — recomputed only when the (base, other) integrity
    // pair changes, so unrelated re-renders don't re-walk every file.
    this._diff = null
    this._diffKey = null
  }

  willUpdate(changed) {
    if ((changed.has('_otherDetails') || changed.has('details')) && this._status === 'ready'
      && !bundleCompareScopes(this.details, this._otherDetails).some(scope => scope.id === this._scope)) this._scope = ''
    // Reset only when the BASE bundle itself changes (integrity). A
    // details object swapped in for the SAME integrity — the parse
    // landing after a navigation, or fileHashes attaching in place — is
    // the same content, so the comparison stays valid; resetting there
    // would wipe the target the instant the base finished loading.
    if (changed.has('integrity')) this._rebase()
    // A link's bundle and mode, or the ones Compare reported, idle when
    // already shown. One withdrawn — this bundle reopened on a bare
    // Compare route — takes the comparison with it.
    if ((changed.has('request') || changed.has('integrity')) && this.integrity && this.request?.bundle === this.integrity) {
      if (this.request.target !== this._targetIntegrity) this._choose(this.request.target)
      this._mode = compareModeOf(this.request.mode)
    } else if (changed.has('request') && !changed.has('integrity') && changed.get('request')?.bundle === this.integrity) {
      if (this._targetIntegrity) this._choose(null)
      this._mode = 'overview'
    }
  }

  // The base bundle changed: compare it afresh, or after a swap, with the
  // old base.
  _rebase() {
    // A swap, or a pick on this side, navigates to the new base; in that
    // case restore the target it was opened to compare with instead of
    // clearing it (the module-level handoff survives the prop teardown the
    // navigation triggers). One that landed elsewhere (another bundle
    // opened first) is over.
    const base = this._baseKey
    if (_pendingSwap && base && base !== _pendingSwap.base) _pendingSwap = null
    if (_pendingSwap && base === _pendingSwap.base) {
      const { target } = _pendingSwap
      this._scope = _pendingSwap.scope
      this._mode = _pendingSwap.mode
      this._codePath = _pendingSwap.codePath
      _pendingSwap = null
      if (!target) {
        this._targetIntegrity = null
        this._otherDetails = null
        this._status = 'idle'
        return
      }
      this._targetIntegrity = target
      this._diff = null
      this._diffKey = null
      // The old base is still parsed: compare against it as it stands.
      const handed = this.source ? null : takeHandedOffBundle(target, details => Boolean(details.json || details.bundle))
      if (handed) {
        this._otherDetails = handed
        this._status = 'ready'
      } else {
        this._otherDetails = null
        this._status = 'loading'
        this._loadOther(target)
      }
      return
    }
    this._targetIntegrity = null
    this._otherDetails = null
    this._status = 'idle'
    this._scope = ''
    this._codePath = null
    this._diff = null
    this._diffKey = null
  }

  // The id this side is picked by: its integrity, or its source's id.
  get _baseKey() {
    return this.source ? this.source.base : this.integrity
  }

  // Swap A and B: open the current comparison target as the active bundle
  // and compare it with the old base.
  _swap() {
    const target = this._targetIntegrity
    if (target && target !== this._baseKey) this._reopen(target, this._baseKey)
  }

  // A pick on this side: open it to compare with the same target, or with
  // the old base when it is the target (a swap).
  _pickBase(value) {
    if (!value || value === this._baseKey) return
    if (value === this._targetIntegrity) this._swap()
    else this._reopen(value, this._targetIntegrity)
  }

  // Open `base` (the app navigates to it), compared with `target` (null:
  // nothing picked yet). The pending slot carries the target, scope, mode
  // and Code file across the base change. events.js handles the bundle
  // switch off the dispatched event (the path a sidebar row click takes);
  // what is already parsed of either side is handed to its new role rather
  // than read from storage and parsed again. A source opens its own.
  _reopen(base, target) {
    if (this.source) {
      _pendingSwap = { base, target, scope: this._scope, mode: this._mode, codePath: this._codePath }
      this.source.open(base, target, this._mode)
      return
    }
    if (!bundleComparisonCandidates(state.bundles ?? [], this.integrity).some(b => b.integrity === base)) return
    _pendingSwap = { base, target, scope: this._scope, mode: this._mode, codePath: this._codePath }
    const parsed = details => details && !details.error && (details.json || details.bundle) && [base, target].includes(details.integrity)
    const bundles = [this._otherDetails, this._baseReady ? this.details : null].filter(parsed)
    this.dispatchEvent(new CustomEvent('bundle-swap', {
      bubbles: true,
      composed: true,
      detail: { integrity: base, target, bundles, mode: this._mode },
    }))
  }

  // Friendly name for an integrity, resolved from the sidebar's cached
  // bundle list (`state.bundles`). Falls back to a short integrity
  // prefix when the entry isn't found (deleted out from under us).
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

  // The user's comparison — the bundle compared with and the mode — for the
  // URL of a managed bundle (events.js).
  _notify() {
    this.dispatchEvent(new CustomEvent('bundle-compare-change', {
      bubbles: true,
      composed: true,
      detail: { base: this.integrity, target: this._targetIntegrity, mode: this._mode },
    }))
  }

  // Empty value clears the comparison; otherwise kick the state-free
  // parse of the chosen bundle and re-render through each status. The
  // parsed other-bundle is dropped immediately so a stale diff doesn't
  // linger under the spinner.
  _choose(value) {
    const integrity = value || null
    this._targetIntegrity = integrity
    this._otherDetails = null
    this._codePath = null
    this._diff = null
    this._diffKey = null
    if (!integrity) { this._status = 'idle'; this._scope = ''; return }
    this._status = 'loading'
    this._loadOther(integrity)
  }

  async _loadOther(integrity) {
    if (this.source) {
      let details
      try { details = await this.source.load(integrity) }
      catch (err) {
        if (err.name === 'AbortError') return
        details = { error: err.message }
      }
      if (this._targetIntegrity !== integrity) return
      this._otherDetails = details
      this._status = 'ready'
      return
    }
    const entry = bundleComparisonCandidates(state.bundles ?? [], this.integrity).find(b => b.integrity === integrity)
    if (!entry) { this._status = 'idle'; this._targetIntegrity = null; this._notify(); return }
    let details
    try { details = await buildBundleDetails(integrity, entry) }
    catch (err) { if (err.name === 'AbortError') return; throw err }
    // Drop a stale resolve: the user re-picked (or switched the base
    // bundle, which willUpdate reset to null) while this parse was in
    // flight, so the result is for a selection that no longer stands.
    if (this._targetIntegrity !== integrity) return
    this._otherDetails = details
    this._status = 'ready'
  }

  // True once the open bundle is parsed and matches the integrity we
  // were handed — guards the brief window where `state.bundleDetails`
  // is still null / pointing at the previous selection.
  get _baseReady() {
    return Boolean(
      this.details
        && this.details.integrity === this.integrity
        && (this.details.json || this.details.bundle),
    )
  }

  // Review a file's changes in the Code view.
  _openFile(path) {
    this._codePath = path
    this._mode = 'code'
    this._notify()
  }

  _fileRow(path, label, sizeTpl, tooltip = path) {
    return html`<li><button type="button" class="bundle-compare-row bundle-compare-row-link" @click=${() => this._openFile(path)}>
      <span class="bundle-compare-row-path mono" data-tooltip-truncated data-tooltip=${tooltip}>${label}</span>${sizeTpl}
    </button></li>`
  }

  // Card shell shared by every file / package group: the kind-tinted
  // section, dot + title + exact count header, and every row in a list
  // that scrolls — as tall as the pane allows with `fill`. It sits in its
  // kind's lane of `lanes` (see _cols); `style` sets more custom
  // properties on the card. Returns `nothing` for an empty group so a
  // section only shows what actually moved. `keyOf` / `rowOf` are the
  // `repeat` key + row template.
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

  // Size cells for a file / package row: one byte count for a row that
  // exists on a single side, the signed delta for a changed row, with
  // `base → other` in its tooltip. A side with no size to give shows a
  // dash, as does the delta it leaves undefined.
  _sizeCells(r) {
    const bytes = value => value == null ? '—' : formatBytes(value)
    return r.delta === undefined
      ? html`<span class="bundle-compare-row-size">${bytes(r.bytes)}</span>`
      : html`<span class=${`bundle-compare-row-delta ${r.delta === null ? '' : dirClass(r.delta)}`}
          data-tooltip=${`${bytes(r.baseBytes)} → ${bytes(r.otherBytes)}`}>${r.delta === null ? '—' : formatDelta(r.delta)}</span>`
  }

  // Name | Size order for one group, kept per kind in the state field
  // `field` (`_fileSort` / `_pkgSort`).
  _sortActions(field, kind, label) {
    const sort = this[field][kind]
    return html`<span class="bundles-overview-sort" role="group" aria-label=${`${kind} ${label} order`}>
      ${[['name', 'Name'], ['size', 'Size']].map(([value, text]) => html`<button type="button" aria-pressed=${String(sort === value)} @click=${() => { this[field] = { ...this[field], [kind]: value } }}>${text}</button>`)}
    </span>`
  }

  // One file group, every row listed (the list scrolls); the kind selects
  // its accent. Size order is the largest first, or for Changed the
  // largest change in size, name order breaking ties.
  _fileGroup(title, rows, kind, displayOf, lanes) {
    const sort = this._fileSort[kind]
    const weight = r => kind === 'changed' ? Math.abs(r.delta) : r.bytes
    const sorted = rows.toSorted((a, b) => (sort === 'size' ? weight(b) - weight(a) : 0) || a.path.localeCompare(b.path))
    // A renamed file reads `src/{a.js → a.ts}`, the old part red, the new green.
    const row = r => r.basePath == null ? this._fileRow(r.path, displayOf(r.path), this._sizeCells(r))
      : this._fileRow(r.path, renameTemplate(displayOf(r.basePath), displayOf(r.path)), this._sizeCells(r), `${r.basePath} → ${r.path}`)
    return this._group(title, sorted, kind, (r) => r.path, row, this._sortActions('_fileSort', kind, 'file'), { lanes })
  }

  // One package group: a package each, with its versions and its size —
  // both sides of each for a changed one — every one listed, scrolling in
  // its card as tall as the pane allows. Rows carry the package color dot
  // for continuity with the size distribution + treemap. Size order is the
  // largest first, or the largest move for Changed. Removed / Added size
  // their version column to the longest list (monospace, so in `ch`), so
  // versions and sizes line up row to row.
  _pkgGroup(title, rows, kind, lanes) {
    const sort = this._pkgSort[kind]
    // A side without a size sorts last.
    const weight = r => { const value = kind === 'changed' ? r.delta : r.bytes; return value == null ? -1 : Math.abs(value) }
    const sorted = rows.toSorted((a, b) => (sort === 'size' ? weight(b) - weight(a) : 0) || pkgLabel(a.pkg).localeCompare(pkgLabel(b.pkg)))
    const versionChars = kind === 'changed' ? 0 : Math.min(MAX_VERSION_CHARS, Math.max(0, ...rows.map(r => versionList(r.versions).length)))
    return this._group(title, sorted, kind, (r) => r.pkg, (r) => html`<li><div class="bundle-compare-row">
      <span class="bundle-compare-pkg-dot" style=${styleMap({ background: pkgColor(r.pkg) })}></span>
      <span class="bundle-compare-row-path" data-tooltip-truncated data-tooltip=${pkgLabel(r.pkg)}>${pkgLabel(r.pkg)}</span>
      ${kind === 'changed' ? this._versionCell(r) : versionChars > 0 ? html`<span class="bundle-compare-dep-ver" data-tooltip-truncated data-tooltip=${versionList(r.versions)}>${versionList(r.versions)}</span>` : nothing}
      ${this._sizeCells(kind === 'changed' ? r : { bytes: r.bytes })}
    </div></li>`, this._sortActions('_pkgSort', kind, 'package'),
    { fill: true, lanes, style: versionChars > 0 ? { '--compare-version-width': `${versionChars}ch` } : {} })
  }

  // A changed package's versions: `old → new` with the new side colored by
  // direction (↑ green / ↓ red / ± amber) and a matching glyph, spelled out
  // for screen readers; the one list when only its size moved; nothing for
  // a package without versions (own source, workspace modules).
  _versionCell(r) {
    const after = r.otherVersions, before = r.baseVersions
    if (before.join() === after.join()) {
      return before.length > 0 ? html`<span class="bundle-compare-dep-ver">${versionList(before)}</span>` : nothing
    }
    const direction = r.direction ?? 'changed'
    const glyph = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '±'
    const word = direction === 'up' ? 'Upgraded' : direction === 'down' ? 'Downgraded' : 'Changed'
    return html`<span class="bundle-compare-ver" aria-label=${`${word}: ${versionList(before) || 'none'} to ${versionList(after) || 'none'}`}>
      <span class="bundle-compare-ver-from">${versionList(before) || '—'}</span>
      <span class="bundle-compare-ver-arrow" aria-hidden="true">→</span>
      <span class=${`bundle-compare-ver-to ${direction}`}>${versionList(after) || '—'}</span>
      <span class=${`bundle-compare-ver-dir ${direction}`} aria-hidden="true">${glyph}</span>
    </span>`
  }

  // A source's dependencies (see `source`): the range each requires, or for
  // Changed the one it moved from and to; `kind` marks peer and optional.
  _depGroup(title, rows, kind, lanes) {
    const rangeChars = kind === 'changed' ? 0 : Math.min(MAX_VERSION_CHARS, Math.max(0, ...rows.map(r => r.range.length)))
    return this._group(title, rows, kind, r => r.key, r => html`<li><div class="bundle-compare-row">
      <span class="bundle-compare-row-path" data-tooltip-truncated data-tooltip=${r.name}>${r.name}</span>
      ${r.kind ? html`<span class="npm-dependency-kind">${r.kind}</span>` : nothing}
      ${kind === 'changed' ? html`<span class="bundle-compare-ver" aria-label=${`Changed: ${r.from} to ${r.to}`}>
          <span class="bundle-compare-ver-from">${r.from}</span>
          <span class="bundle-compare-ver-arrow" aria-hidden="true">→</span>
          <span class="bundle-compare-ver-to changed">${r.to}</span>
        </span>`
        : html`<span class="bundle-compare-dep-ver" data-tooltip-truncated data-tooltip=${r.range}>${r.range}</span>`}
    </div></li>`, nothing, { fill: true, lanes, style: rangeChars > 0 ? { '--compare-version-width': `${rangeChars}ch` } : {} })
  }

  _renderDependencies(rows, baseName, otherName, lanes) {
    if (lanes.length === 0) return nothing
    return html`<section class="bundle-compare-section">
      <h3 class="bundle-compare-section-head">Dependencies</h3>
      ${this._cols(lanes, html`
        ${this._depGroup(`Removed · only in ${baseName}`, rows.removed, 'removed', lanes)}
        ${this._depGroup(`Added · only in ${otherName}`, rows.added, 'added', lanes)}
        ${this._depGroup('Changed', rows.changed, 'changed', lanes)}`)}
    </section>`
  }

  // Packages section: removed | added | changed, each package once, from
  // its files' sizes and the versions each bundle records. Returns
  // `nothing` when no package moved.
  _renderPackages(rows, baseName, otherName, lanes = LANES) {
    if (rows.removed.length === 0 && rows.added.length === 0 && rows.changed.length === 0) return nothing
    return html`<section class="bundle-compare-section">
      <h3 class="bundle-compare-section-head">Packages</h3>
      ${this._cols(lanes, html`
        ${this._pkgGroup(`Removed · only in ${baseName}`, rows.removed, 'removed', lanes)}
        ${this._pkgGroup(`Added · only in ${otherName}`, rows.added, 'added', lanes)}
        ${this._pkgGroup('Changed', rows.changed, 'changed', lanes)}`)}
    </section>`
  }

  // Removed | Added | Changed columns, one lane per kind in `lanes`
  // (Changed's the widest). Files takes Packages' lanes to line up under
  // them when it can (see _renderDiff), an empty lane where it lacks a kind.
  _cols(lanes, groups) {
    const template = lanes.map(kind => kind === 'changed' ? 'minmax(0, 5fr)' : 'minmax(0, 4fr)').join(' ')
    return html`<div class="bundle-compare-cols" data-lanes=${lanes.length} style=${styleMap({ '--compare-lanes': template })}>${groups}</div>`
  }

  // A section that opens on demand, its heading the disclosure (with an
  // optional path `note`); its contents render only while it is open. A
  // click on the heading opens it through the render, contents and all:
  // left to the browser, it opened a frame before its contents arrived. A
  // toggle the browser makes on its own (find in page) still lands.
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

  // Repointed imports as a table, File | Import | Before | After |
  // Conditions, one line a row, in a card like the groups'; a file opens
  // in Code. Conditions drops out when every row reads `*`.
  _renderResolutions(resolutions) {
    if (resolutions.totalChanges === 0) return nothing
    const rows = resolutions.changed
    const shown = rows.slice(0, MAX_ROWS)
    const hidden = rows.length - shown.length
    const cell = (text, className = '') => html`<td class=${className}><code data-tooltip-truncated data-tooltip=${text}>${text}</code></td>`
    const contextOf = r => `${r.conditions}${r.platform === null ? '' : ` · Platform: ${r.platform}`}`
    // `*` (any conditions, every platform) on every row tells nothing apart.
    const showContext = shown.some(r => contextOf(r) !== '*')
    return this._collapsible('resolutions', 'Import resolutions', rows.length, () => html`
      <section class="bundle-compare-group bundle-compare-changed bundle-compare-resolutions">
        <header class="bundle-compare-group-head">
          <span class="bundle-compare-dot" aria-hidden="true"></span>
          <span class="bundle-compare-group-title">Repointed</span>
          <span class="bundle-compare-group-count">${rows.length}</span>
        </header>
        <table class=${showContext ? '' : 'bundle-compare-resolutions--no-context'}>
          <thead><tr><th>File</th><th>Import</th><th>Before</th><th>After</th>${showContext ? html`<th>Conditions</th>` : nothing}</tr></thead>
          <tbody>${repeat(shown, r => r.key, r => {
            const context = contextOf(r)
            return html`<tr>
              <td><button type="button" class="bundle-compare-resolution-parent" data-tooltip-truncated data-tooltip=${r.parent} @click=${() => this._openFile(r.parent)}>${r.parent}</button></td>
              ${cell(r.specifier)}
              ${cell(r.baseTarget || '(empty target)', 'bundle-compare-resolution-before')}
              ${cell(r.otherTarget || '(empty target)', 'bundle-compare-resolution-after')}
              ${showContext ? html`<td class="bundle-compare-resolution-context"><span data-tooltip-truncated data-tooltip=${context}>${context}</span></td>` : nothing}
            </tr>`
          })}</tbody>
        </table>
        ${hidden > 0 ? html`<div class="bundle-compare-more">and ${hidden.toLocaleString()} more…</div>` : nothing}
      </section>`)
  }

  // Compute (or reuse the memo of) the diff for the current pairing.
  _diffFor() {
    const key = `${this.integrity}|${this._targetIntegrity}|${this._scope}`
    if (this._diffKey !== key || !this._diff) {
      // Every file each side mounts, resources included: a diff of
      // source alone would call two bundles identical when only their
      // images differ, and total less than the Overview does.
      const baseSources = bundleCompareFiles(this.details, this._scope)
      const otherSources = bundleCompareFiles(this._otherDetails, this._scope)
      // Classify original paths and preserve recorded Stasis package
      // boundaries from either side. Own source has one identity.
      const baseDirs = bundlePackageDirs(this.details)
      const otherDirs = bundlePackageDirs(this._otherDetails)
      const packageDirs = baseDirs || otherDirs
        ? new Map([...(baseDirs ?? []), ...(otherDirs ?? [])])
        : null
      const pkgOf = (p) => bundlePkgOf(p, { packageDir: packageDirs?.get(p) })
      this._diff = computeBundleDiff(baseSources, otherSources, pkgOf)
      this._diff.resolutions = computeResolutionDiff(
        bundleCompareResolutions(this.details, this._scope),
        bundleCompareResolutions(this._otherDetails, this._scope),
        new Map(this._diff.files.changed.filter(row => row.basePath != null).map(row => [row.basePath, row.path])),
      )
      // Dependency versions come from the stasis per-module `{ name,
      // version }` metadata, not the path/byte walk above, so they're
      // computed alongside and hung off the same memo: the package rows
      // join them to the sizes, the summary counts them. Empty for
      // sourcemap / v0 pairs (no version metadata), whose rows carry sizes
      // alone.
      // Keyed by install directory, as the sizes are (`bundlePkgOf`).
      const versionKey = dir => bundlePkgOf('', { packageDir: dir })
      const baseVersions = bundlePackageVersions(this.details, this._scope ? baseSources.keys() : null, versionKey)
      const otherVersions = bundlePackageVersions(this._otherDetails, this._scope ? otherSources.keys() : null, versionKey)
      this._diff.versionUpdates = computeVersionUpdates(baseVersions, otherVersions)
      this._diff.packageRows = comparePackages(this._diff.packages, baseVersions, otherVersions)
      this._diffKey = key
    }
    return this._diff
  }

  // How many rows the Diff view would list, counted up to COMBINED_DIFF_MAX,
  // with the line models found on the way, kept with the comparison.
  _combinedFor() {
    const diff = this._diffFor()
    return diff.combined ??= combinedDiffRows(this.details, this._otherDetails, diff.files)
  }

  // Whether the Diff view is offered: only while its list is short enough to
  // read whole.
  get _diffFits() { return this._combinedFor().rows < COMBINED_DIFF_MAX }

  // The mode shown: a link to Diff for a longer list shows the Overview.
  get _shownMode() {
    return this._mode === 'diff' && !this._diffFits ? 'overview' : this._mode
  }

  // Summary band — file + size (+ dependency) deltas plus the four
  // bucket chips, wrapping on their own so the mode tabs keep to the right
  // of the first line. Sits under the picker once a comparison is live.
  _renderSummary(diff) {
    const totals = diff.totals
    const vt = diff.versionUpdates.totals
    // Dependency count only means something when at least one side
    // carries version metadata (stasis v1); hide the metric for
    // sourcemap / v0 pairs rather than show a hollow `0 → 0`.
    const showDeps = vt.baseDeps > 0 || vt.otherDeps > 0
    const depDelta = vt.otherDeps - vt.baseDeps
    const pct = formatPct(totals.byteDelta, totals.baseBytes)
    return html`<div class="bundle-compare-summary"><div class="bundle-compare-stats">
      <div class="bundle-compare-metric">
        <span class="bundle-compare-metric-label">Files</span>
        <span class="bundle-compare-metric-value">${totals.baseFiles.toLocaleString()} → ${totals.otherFiles.toLocaleString()}</span>
        <span class=${`bundle-compare-metric-delta ${dirClass(totals.fileDelta)}`}>${formatCountDelta(totals.fileDelta)}</span>
      </div>
      <div class="bundle-compare-metric">
        <span class="bundle-compare-metric-label">Size</span>
        <span class="bundle-compare-metric-value">${formatBytes(totals.baseBytes)} → ${formatBytes(totals.otherBytes)}</span>
        <span class=${`bundle-compare-metric-delta ${dirClass(totals.byteDelta)}`}>${formatDelta(totals.byteDelta)}${pct ? html`${' '}<span class="bundle-compare-pct">(${pct})</span>` : nothing}</span>
      </div>
      ${showDeps ? html`<div class="bundle-compare-metric">
        <span class="bundle-compare-metric-label">Deps</span>
        <span class="bundle-compare-metric-value">${vt.baseDeps.toLocaleString()} → ${vt.otherDeps.toLocaleString()}</span>
        <span class=${`bundle-compare-metric-delta ${dirClass(depDelta)}`}>${formatCountDelta(depDelta)}</span>
      </div>` : nothing}
      <div class="bundle-compare-chips">
        <span class="bundle-compare-chip removed">−${totals.onlyBaseFiles.toLocaleString()} removed</span>
        <span class="bundle-compare-chip added">+${totals.onlyOtherFiles.toLocaleString()} added</span>
        <span class="bundle-compare-chip changed">${totals.changedFiles.toLocaleString()} changed${totals.renamedFiles > 0 ? ` (${totals.renamedFiles.toLocaleString()} renamed)` : ''}</span>
        <span class="bundle-compare-chip unchanged">${totals.unchangedFiles.toLocaleString()} unchanged</span>
        ${diff.resolutions.totalChanges > 0 ? html`<span class="bundle-compare-chip changed">${diff.resolutions.totalChanges.toLocaleString()} repointed ${diff.resolutions.totalChanges === 1 ? 'resolution' : 'resolutions'}</span>` : nothing}
      </div></div>
      <div class="bundle-compare-modes" role="tablist" aria-label="Comparison view">
        ${[['overview', 'Overview'], ['code', 'Code'], ...this._diffFits ? [['diff', 'Diff']] : []]
          .map(([mode, label]) => html`<button type="button" role="tab"
          aria-selected=${String(this._shownMode === mode)} @click=${() => { this._mode = mode; this._notify() }}>${label}</button>`)}
      </div>
    </div>`
  }

  _renderPicker(others, hasTarget, scopeSelector) {
    const noun = this.source?.noun ?? 'bundle'
    const Noun = `${noun[0].toUpperCase()}${noun.slice(1)}`
    return html`<div class="bundle-compare-picker">
      <div class="bundle-compare-select-wrap bundle-compare-base-wrap">
        <bundle-selector .bundles=${this._baseOptions()} .value=${this._baseKey} .noun=${noun} .versions=${Boolean(this.source)}
          label=${`${Noun} to compare`} placeholder=${this._nameFor(this.integrity)} @bundle-change=${event => this._pickBase(event.detail.value)}></bundle-selector>
      </div>
      <span class="bundle-compare-arrow" aria-hidden="true">→</span>
      <div class="bundle-compare-select-wrap">
        <span class="bundle-compare-select-hint">Compare with</span>
        <bundle-selector .bundles=${others} .value=${this._targetIntegrity} .noun=${noun} .versions=${Boolean(this.source)}
          label=${`${Noun} to compare with`} placeholder=${`Choose a ${noun}…`} @bundle-change=${event => this._pick(event.detail.value)}></bundle-selector>
        ${hasTarget ? html`<button type="button" class="bundle-compare-clear" aria-label="Clear comparison" @click=${() => this._pick(null)}>×</button>
          <button
            type="button"
            class="bundle-compare-swap"
            @click=${() => this._swap()}
            aria-label=${`Swap the two ${noun}s`}
          ><span class="bundle-compare-swap-icon" aria-hidden="true">↔</span>Swap</button>` : nothing}
      </div>
      ${scopeSelector}
    </div>`
  }

  // What this side may become: the open bundle and those it compares with,
  // or a source's choices.
  _baseOptions() {
    if (this.source) return this._sourceOptions(this.source.choices ?? [])
    const base = (state.bundles ?? []).find(bundle => bundle.integrity === this.integrity)
    const others = bundleComparisonCandidates(state.bundles ?? [], this.integrity)
    return this._bundleOptions(base ? [base, ...others] : others)
  }

  _sourceOptions(options) {
    return options.map(option => ({ id: option.id, integrity: option.id, kind: option.format, format: option.format,
      detail: option.detail, filename: option.name, displayLabel: option.displayLabel, size: '—', summary: null }))
  }

  // Build the picker option list, disambiguating duplicate names with a
  // short integrity suffix so two same-named bundles are tellable apart.
  _otherOptions() {
    if (this.source) return this._sourceOptions(this.source.options)
    return this._bundleOptions(bundleComparisonCandidates(state.bundles ?? [], this.integrity))
  }

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
    // The picked bundle may have been deleted out from under us (in
    // this tab or another) while its diff was showing — treat a target
    // that's no longer on disk as no selection so we don't keep
    // rendering a diff against a bundle the user can't see in the list.
    // A source's target stands while its options are still listing: the
    // load says whether it exists.
    const hasTarget = Boolean(this._targetIntegrity)
      && (Boolean(this.source) || others.some((o) => o.integrity === this._targetIntegrity))
    const scopes = this._baseReady ? bundleCompareScopes(this.details, hasTarget ? this._otherDetails : null) : []
    const scopeSelector = scopes.length > 0
      ? html`<bundle-scope-selector .reasons=${scopes} .value=${this._scope} label="Compare scope" @scope-change=${event => { this._scope = event.detail.value }}></bundle-scope-selector>`
      : nothing
    // Picker is always present (when there's anything to pick) so the
    // user can switch the compared bundle without leaving the tab; the
    // swap button rides next to the clear button once a target is live,
    // and the scope selector sits at the row's right end, so the head is
    // one row before a pick and two (picker, summary) after.
    const picker = others.length > 0 || this.source ? this._renderPicker(others, hasTarget, scopeSelector) : scopeSelector
    const noun = this.source?.noun ?? 'bundle'
    const ready = hasTarget
      && this._status === 'ready'
      && this._otherDetails
      && (this._otherDetails.json || this._otherDetails.bundle)
      && !this._otherDetails.error

    let body
    if (!this._baseReady) {
      body = html`<div class="bundle-compare-empty">Loading bundle…</div>`
    } else if (this.source && !hasTarget && (this.source.pending || this.source.error || others.length === 0)) {
      body = html`<div class=${`bundle-compare-empty${this.source.error ? ' is-error' : ''}`}>${this.source.pending ? `Loading ${noun}s…`
        : this.source.error ?? html`No other ${noun}s to compare <strong>${this._nameFor(this.integrity)}</strong> with.`}</div>`
    } else if (others.length === 0 && !this.source) {
      body = html`<div class="bundle-compare-empty">No other bundles to compare with. Drop a second <code>.map</code> or <code>.stasis.code.br</code> bundle to diff against this one.</div>`
    } else if (!hasTarget) {
      body = html`<div class="bundle-compare-empty">Pick a ${noun} above to compare against <strong>${this._nameFor(this.integrity)}</strong>.</div>`
    } else if (this._status === 'loading' || !this._otherDetails) {
      body = html`<div class="bundle-compare-empty">Comparing…</div>`
    } else if (this._otherDetails.error) {
      body = html`<div class="bundle-compare-empty is-error">Couldn't read the selected ${noun}: ${this._otherDetails.error}</div>`
    } else if (!this._otherDetails.json && !this._otherDetails.bundle) {
      body = html`<div class="bundle-compare-empty is-error">The selected ${noun} couldn't be parsed.</div>`
    } else {
      body = this._renderDiff()
    }

    const mode = this._baseReady && ready ? this._shownMode : 'overview'
    return html`<div class="bundle-compare">
      <header class="bundle-compare-head">
        ${picker}
        ${this._baseReady && ready ? this._renderSummary(this._diffFor()) : nothing}
      </header>
      ${mode === 'code' ? html`<bundle-compare-code .base=${this.details} .other=${this._otherDetails} .files=${this._diffFor().files} .resolutions=${this._diffFor().resolutions.changed}
          .path=${this._codePath} baseName=${this._nameFor(this.integrity)} otherName=${this._nameFor(this._targetIntegrity)}
          @compare-code-select=${event => { this._codePath = event.detail.path }}></bundle-compare-code>`
        : mode === 'diff' ? html`<bundle-compare-all .base=${this.details} .other=${this._otherDetails} .files=${this._diffFor().files}
          .models=${this._combinedFor().models} baseName=${this._nameFor(this.integrity)} otherName=${this._nameFor(this._targetIntegrity)}></bundle-compare-all>`
        : html`<div class="bundle-compare-body">${body}</div>`}
    </div>`
  }

  _renderDiff() {
    const diff = this._diffFor()
    const otherName = this._nameFor(this._targetIntegrity)
    const baseName = this._nameFor(this.integrity)
    // Display paths are prefix-stripped over the union of everything
    // listed, so the rows don't repeat a shared build-output root; the
    // click target keeps the original (un-stripped) key.
    const allPaths = [
      ...diff.files.onlyBase.map((r) => r.path),
      ...diff.files.onlyOther.map((r) => r.path),
      ...diff.files.changed.flatMap((r) => r.basePath == null ? [r.path] : [r.path, r.basePath]),
    ]
    const { prefix, stripped } = stripCommonPathPrefix(allPaths)
    const displayMap = new Map()
    for (let i = 0; i < allPaths.length; i++) displayMap.set(allPaths[i], stripped[i])
    const displayOf = (p) => displayMap.get(p) ?? p

    const fileCount = diff.files.onlyBase.length + diff.files.onlyOther.length + diff.files.changed.length
    const files = { removed: diff.files.onlyBase, added: diff.files.onlyOther, changed: diff.files.changed }
    const listsFiles = !diff.totals.identical
    // Files line up under Packages, the main columns, while Packages has a
    // lane for each kind Files lists; otherwise each lays out its own kinds,
    // Packages without an empty column.
    // A source may list its own dependencies in place of Packages.
    const dependencies = this.source?.dependencies?.(this.details, this._otherDetails) ?? null
    const packageLanes = LANES.filter(kind => (dependencies ?? diff.packageRows)[kind].length > 0)
    const fileKinds = listsFiles ? LANES.filter(kind => files[kind].length > 0) : []
    const fileLanes = fileKinds.every(kind => packageLanes.includes(kind)) ? packageLanes : fileKinds

    // The header and the group titles already say which bundle is which;
    // the shared root the file rows drop rides on the Files heading.
    return html`
      ${dependencies ? this._renderDependencies(dependencies, baseName, otherName, packageLanes)
        : this._renderPackages(diff.packageRows, baseName, otherName, packageLanes)}
      ${diff.totals.identical
        ? diff.resolutions.totalChanges > 0
          ? html`<div class="bundle-compare-caption">File contents are unchanged; import resolutions differ.</div>`
          : html`<div class="bundle-compare-identical">These two bundles carry identical files (${diff.totals.unchangedFiles.toLocaleString()} ${diff.totals.unchangedFiles === 1 ? 'file' : 'files'}).</div>`
        : this._collapsible('files', 'Files', fileCount, () => this._cols(fileLanes, html`
            ${this._fileGroup(`Removed · only in ${baseName}`, files.removed, 'removed', displayOf, fileLanes)}
            ${this._fileGroup(`Added · only in ${otherName}`, files.added, 'added', displayOf, fileLanes)}
            ${this._fileGroup('Changed', files.changed, 'changed', displayOf, fileLanes)}`), prefix)}
      ${this._renderResolutions(diff.resolutions)}
    `
  }
}

customElements.define('bundle-compare', BundleCompare)
