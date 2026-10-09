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
import { LitElement, html, nothing } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from 'lit/directives/style-map.js'
import { state } from '#client/index.js'
import { formatBytes, stripCommonPathPrefix } from './format.js'
import { pkgColor } from './graph/utils.js'
import { bundlePkgOf, pkgLabel } from './bundle-pkg-of.js'
import { bundlePackageDirs, bundlePackageVersions } from './bundle-sources.js'
import { buildBundleDetails, handOffBundles, takeHandedOffBundle } from './bundle-load.js'
import { bundleComparisonCandidates } from './bundle-comparison-candidates.js'
import { computeBundleDiff, computeResolutionDiff, computeVersionUpdates } from './bundle-compare-diff.js'
import { bundleCompareFiles, bundleCompareResolutions, bundleCompareScopes } from './bundle-compare-inputs.js'
import './bundle-selector.js'
import './bundle-scope-selector.js'
import './bundle-compare-code.js'

// Cap each file group's rendered rows so a pathological compare (a
// stasis bundle vendoring thousands of files against an unrelated
// one) can't stamp out tens of thousands of DOM nodes. The summary
// counts are always exact; only the per-row listing is trimmed, with
// an "and N more" footer.
const MAX_ROWS = 400

// Swap handoff. The swap button switches the active bundle to the
// current comparison target (so A and B trade places, and the app
// navigates to the other bundle). That base change would normally clear
// the comparison in willUpdate; this module-level slot carries the
// intended new target (the old base) across the prop teardown — a
// component-internal field wouldn't survive the navigation. Shape:
// `{ base, target, scope, mode, codePath }`, consumed once by willUpdate
// when integrity flips to `base`, or dropped when another bundle opens.
// It holds no parsed bundle: those go through handOffBundles, which keeps
// them no longer than the swap's own view.
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
    // Integrity of the bundle picked to compare against (null = none
    // chosen yet), the parsed bytes of that bundle once loaded, and a
    // coarse load status the body switches on.
    _targetIntegrity: { state: true },
    _otherDetails: { state: true },
    _status: { state: true },
    _scope: { state: true },
    _fileSort: { state: true },
    // 'overview' | 'code', and the file the Code view shows (null: its
    // first changed file).
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
    this._targetIntegrity = null
    this._otherDetails = null
    this._status = 'idle'
    this._scope = ''
    this._fileSort = { removed: 'name', added: 'name', changed: 'name' }
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
    if (!changed.has('integrity')) return
    // A swap navigates to the old comparison target as the new base; in
    // that single case restore the old base as the new target instead
    // of clearing it (the module-level handoff survives the prop
    // teardown the navigation triggers). A swap that landed elsewhere
    // (another bundle opened first) is over.
    if (_pendingSwap && this.integrity && this.integrity !== _pendingSwap.base) _pendingSwap = null
    if (_pendingSwap && this.integrity === _pendingSwap.base) {
      const { target } = _pendingSwap
      this._scope = _pendingSwap.scope
      this._mode = _pendingSwap.mode
      this._codePath = _pendingSwap.codePath
      _pendingSwap = null
      this._targetIntegrity = target
      this._diff = null
      this._diffKey = null
      // The old base is still parsed: compare against it as it stands.
      const handed = takeHandedOffBundle(target, details => Boolean(details.json || details.bundle))
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

  // Swap A and B: open the current comparison target as the active
  // bundle (so the app navigates to it) and flip the comparison to the
  // old base. The pending-swap slot carries the new target across the
  // base change; events.js handles the actual bundle switch off the
  // dispatched event (same path the sidebar row click takes). Both sides
  // are already parsed, so each is handed to its new role rather than
  // read from storage and parsed again.
  _swap() {
    const newBase = this._targetIntegrity
    if (!newBase || newBase === this.integrity) return
    if (!bundleComparisonCandidates(state.bundles ?? [], this.integrity).some(b => b.integrity === newBase)) return
    _pendingSwap = { base: newBase, target: this.integrity, scope: this._scope, mode: this._mode, codePath: this._codePath }
    handOffBundles(newBase, [
      this._otherDetails?.integrity === newBase && (this._otherDetails.json || this._otherDetails.bundle) ? this._otherDetails : null,
      this._baseReady ? this.details : null,
    ])
    this.dispatchEvent(new CustomEvent('bundle-swap', {
      bubbles: true,
      composed: true,
      detail: { integrity: newBase },
    }))
  }

  // Friendly name for an integrity, resolved from the sidebar's cached
  // bundle list (`state.bundles`). Falls back to a short integrity
  // prefix when the entry isn't found (deleted out from under us).
  _nameFor(integrity) {
    const entry = (state.bundles ?? []).find((b) => b.integrity === integrity)
    return entry?.name ?? `${integrity.slice(0, 'sha512-'.length + 8)}…`
  }

  // Picker change. Empty value clears the comparison; otherwise kick
  // the state-free parse of the chosen bundle and re-render through
  // each status. The parsed other-bundle is dropped immediately so a
  // stale diff doesn't linger under the spinner.
  _pick(value) {
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
    const entry = bundleComparisonCandidates(state.bundles ?? [], this.integrity).find(b => b.integrity === integrity)
    if (!entry) { this._status = 'idle'; this._targetIntegrity = null; return }
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
  }

  _fileRow(path, label, sizeTpl) {
    return html`<li><button type="button" class="bundle-compare-row bundle-compare-row-link" @click=${() => this._openFile(path)}>
      <span class="bundle-compare-row-path mono" data-tooltip-truncated data-tooltip=${path}>${label}</span>${sizeTpl}
    </button></li>`
  }

  // Card shell shared by every file / package / dependency group: the
  // kind-tinted section, dot + title + exact count header, the row list
  // capped at MAX_ROWS, and the "and N more" footer. Returns `nothing`
  // for an empty group so a section only shows what actually moved.
  // `keyOf` / `rowOf` are the `repeat` key + row template.
  _group(title, rows, kind, keyOf, rowOf, actions = nothing) {
    if (rows.length === 0) return nothing
    const shown = rows.slice(0, MAX_ROWS)
    const hidden = rows.length - shown.length
    return html`<section class=${`bundle-compare-group bundle-compare-${kind}`}>
      <header class="bundle-compare-group-head">
        <span class="bundle-compare-dot" aria-hidden="true"></span>
        <span class="bundle-compare-group-title" data-tooltip-truncated data-tooltip=${title}>${title}</span>
        <span class="bundle-compare-group-count">${rows.length}</span>
        ${actions}
      </header>
      <ul class="bundle-compare-rows">
        ${repeat(shown, keyOf, rowOf)}
      </ul>
      ${hidden > 0 ? html`<div class="bundle-compare-more">and ${hidden.toLocaleString()} more…</div>` : nothing}
    </section>`
  }

  // Size cells for a file / package row: one byte count for a row that
  // exists on a single side, `base → other` plus the signed delta for a
  // changed row.
  _sizeCells(r) {
    return r.delta === undefined
      ? html`<span class="bundle-compare-row-size">${formatBytes(r.bytes)}</span>`
      : html`<span class="bundle-compare-row-size">${formatBytes(r.baseBytes)} → ${formatBytes(r.otherBytes)}</span>
          <span class=${`bundle-compare-row-delta ${dirClass(r.delta)}`}>${formatDelta(r.delta)}</span>`
  }

  // One file group; the kind selects both its accent and its file action.
  _fileGroup(title, rows, kind, displayOf) {
    const sort = this._fileSort[kind]
    const sorted = rows.toSorted((a, b) => (sort === 'size' ? (b.bytes ?? b.otherBytes) - (a.bytes ?? a.otherBytes) : 0)
      || a.path.localeCompare(b.path))
    const actions = html`<span class="bundles-overview-sort" role="group" aria-label=${`${kind} file order`}>
      ${[['name', 'Name'], ['size', 'Size']].map(([value, label]) => html`<button type="button" aria-pressed=${String(sort === value)} @click=${() => { this._fileSort = { ...this._fileSort, [kind]: value } }}>${label}</button>`)}
    </span>`
    return this._group(title, sorted, kind, (r) => r.path,
      (r) => this._fileRow(r.path, displayOf(r.path), this._sizeCells(r)), actions)
  }

  // One package group. Same accent scheme as the file groups; rows
  // carry the package color dot for continuity with the size
  // distribution + treemap.
  _pkgGroup(title, rows, kind) {
    return this._group(title, rows, kind, (r) => r.pkg, (r) => html`<li><div class="bundle-compare-row">
      <span class="bundle-compare-pkg-dot" style=${styleMap({ background: pkgColor(r.pkg) })}></span>
      <span class="bundle-compare-row-path" data-tooltip-truncated data-tooltip=${pkgLabel(r.pkg)}>${pkgLabel(r.pkg)}</span>
      ${this._sizeCells(r)}
    </div></li>`)
  }

  // One Updated row: package dot + name, then `old → new`
  // with the new side colored by direction (↑ green / ↓ red / changed
  // amber) and a matching glyph. The direction is also spelled out in
  // accessible label for screen readers.
  _versionRow(r) {
    const glyph = r.direction === 'up' ? '↑' : r.direction === 'down' ? '↓' : '±'
    const word = r.direction === 'up' ? 'Upgraded' : r.direction === 'down' ? 'Downgraded' : 'Changed'
    return html`<li><div class="bundle-compare-row" aria-label=${`${r.pkg} · ${word}`}>
      <span class="bundle-compare-pkg-dot" style=${styleMap({ background: pkgColor(r.pkg) })}></span>
      <span class="bundle-compare-row-path" data-tooltip-truncated data-tooltip=${r.pkg}>${r.pkg}</span>
      <span class="bundle-compare-ver">
        <span class="bundle-compare-ver-from">${versionList(r.baseVersions)}</span>
        <span class="bundle-compare-ver-arrow" aria-hidden="true">→</span>
        <span class=${`bundle-compare-ver-to ${r.direction}`}>${versionList(r.otherVersions)}</span>
        <span class=${`bundle-compare-ver-dir ${r.direction}`} aria-hidden="true">${glyph}</span>
      </span>
    </div></li>`
  }

  // One added / removed dependency group — package name + the
  // version(s) it carried on the side it appears on. Same tinted card
  // and accent scheme as the file / package groups.
  _depGroup(title, rows, kind) {
    return this._group(title, rows, kind, (r) => r.pkg, (r) => html`<li><div class="bundle-compare-row">
      <span class="bundle-compare-pkg-dot" style=${styleMap({ background: pkgColor(r.pkg) })}></span>
      <span class="bundle-compare-row-path" data-tooltip-truncated data-tooltip=${r.pkg}>${r.pkg}</span>
      <span class="bundle-compare-dep-ver">${versionList(r.versions)}</span>
    </div></li>`)
  }

  // Dependency-update section: version bumps for deps on both sides
  // (the headline — "what did this bump pull in?"), then any deps added
  // / removed wholesale. Returns `nothing` when nothing changed so the
  // section only shows for stasis pairs with real version movement.
  _renderVersionUpdates(vu, baseName, otherName) {
    const { updated, added, removed } = vu
    if (updated.length === 0 && added.length === 0 && removed.length === 0) return nothing
    // Updated | Removed | Added share one row of columns, wrapping by the
    // groups' minimum width like the Packages and Files sections.
    return html`<section class="bundle-compare-section">
      <h3 class="bundle-compare-section-head">Dependency updates</h3>
      <div class="bundle-compare-cols">
        ${this._group('Updated', updated, 'updated', (r) => r.pkg, (r) => this._versionRow(r))}
        ${this._depGroup(`Removed · only in ${baseName}`, removed, 'removed')}
        ${this._depGroup(`Added · only in ${otherName}`, added, 'added')}
      </div>
    </section>`
  }

  _resolutionGroup(rows) {
    return this._group('Repointed', rows, 'changed', r => r.key, r => {
      const context = `${r.conditions}${r.platform === null ? '' : ` · Platform: ${r.platform}`}`
      return html`<li class="bundle-compare-resolution">
        <div class="bundle-compare-resolution-source">
          <button type="button" class="bundle-compare-resolution-parent" data-tooltip-truncated data-tooltip=${r.parent} @click=${() => this._openFile(r.parent)}>${r.parent}</button>
          <span aria-hidden="true">→</span>
          <code data-tooltip-truncated data-tooltip=${r.specifier}>${r.specifier}</code>
          <span class="bundle-compare-resolution-context" data-tooltip-truncated data-tooltip=${context}>${context}</span>
        </div>
        <div class="bundle-compare-resolution-targets">
          <div class="bundle-compare-resolution-before"><span>Before</span><code data-tooltip-truncated data-tooltip=${r.baseTarget || '(empty target)'}>${r.baseTarget || '(empty target)'}</code></div>
          <span aria-hidden="true">→</span>
          <div class="bundle-compare-resolution-after"><span>After</span><code data-tooltip-truncated data-tooltip=${r.otherTarget || '(empty target)'}>${r.otherTarget || '(empty target)'}</code></div>
        </div>
      </li>`
    })
  }

  _renderResolutions(resolutions) {
    if (resolutions.totalChanges === 0) return nothing
    return html`<section class="bundle-compare-section">
      <h3 class="bundle-compare-section-head">Import resolutions</h3>
      <div class="bundle-compare-cols bundle-compare-cols--files">
        ${this._resolutionGroup(resolutions.changed)}
      </div>
    </section>`
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
      )
      // Dependency version changes come from the stasis per-module
      // `{ name, version }` metadata, not the path/byte walk above, so
      // they're computed alongside and hung off the same memo. Empty for
      // sourcemap / v0 pairs (no version metadata) — the section then
      // renders nothing.
      this._diff.versionUpdates = computeVersionUpdates(
        bundlePackageVersions(this.details, this._scope ? baseSources.keys() : null),
        bundlePackageVersions(this._otherDetails, this._scope ? otherSources.keys() : null),
      )
      this._diffKey = key
    }
    return this._diff
  }

  // Summary band — file + size (+ dependency) deltas plus the four
  // bucket chips, wrapping on their own so the Overview | Code tabs keep
  // to the right of the first line. Sits under the picker once a
  // comparison is live.
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
        <span class="bundle-compare-chip changed">${totals.changedFiles.toLocaleString()} changed</span>
        <span class="bundle-compare-chip unchanged">${totals.unchangedFiles.toLocaleString()} unchanged</span>
        ${diff.resolutions.totalChanges > 0 ? html`<span class="bundle-compare-chip changed">${diff.resolutions.totalChanges.toLocaleString()} repointed ${diff.resolutions.totalChanges === 1 ? 'resolution' : 'resolutions'}</span>` : nothing}
      </div></div>
      <div class="bundle-compare-modes" role="tablist" aria-label="Comparison view">
        ${[['overview', 'Overview'], ['code', 'Code']].map(([mode, label]) => html`<button type="button" role="tab"
          aria-selected=${String(this._mode === mode)} @click=${() => { this._mode = mode }}>${label}</button>`)}
      </div>
    </div>`
  }

  _renderPicker(others, hasTarget, scopeSelector) {
    const baseName = this._nameFor(this.integrity)
    return html`<div class="bundle-compare-picker">
      <span class="bundle-compare-base" data-tooltip-truncated data-tooltip=${baseName}>${baseName}</span>
      <span class="bundle-compare-arrow" aria-hidden="true">→</span>
      <div class="bundle-compare-select-wrap">
        <span class="bundle-compare-select-hint">Compare with</span>
        <bundle-selector .bundles=${others} .value=${this._targetIntegrity} label="Bundle to compare with" placeholder="Choose a bundle…" @bundle-change=${event => this._pick(event.detail.value)}></bundle-selector>
        ${hasTarget ? html`<button type="button" class="bundle-compare-clear" aria-label="Clear comparison" @click=${() => this._pick(null)}>×</button>
          <button
            type="button"
            class="bundle-compare-swap"
            @click=${() => this._swap()}
            aria-label="Swap the two bundles"
          ><span class="bundle-compare-swap-icon" aria-hidden="true">↔</span>Swap</button>` : nothing}
      </div>
      ${scopeSelector}
    </div>`
  }

  // Build the picker option list, disambiguating duplicate names with a
  // short integrity suffix so two same-named bundles are tellable apart.
  _otherOptions() {
    const others = bundleComparisonCandidates(state.bundles ?? [], this.integrity)
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
    const hasTarget = Boolean(this._targetIntegrity)
      && others.some((o) => o.integrity === this._targetIntegrity)
    const scopes = this._baseReady ? bundleCompareScopes(this.details, hasTarget ? this._otherDetails : null) : []
    const scopeSelector = scopes.length > 0
      ? html`<bundle-scope-selector .reasons=${scopes} .value=${this._scope} label="Compare scope" @scope-change=${event => { this._scope = event.detail.value }}></bundle-scope-selector>`
      : nothing
    // Picker is always present (when there's anything to pick) so the
    // user can switch the compared bundle without leaving the tab; the
    // swap button rides next to the clear button once a target is live,
    // and the scope selector sits at the row's right end, so the head is
    // one row before a pick and two (picker, summary) after.
    const picker = others.length > 0 ? this._renderPicker(others, hasTarget, scopeSelector) : scopeSelector
    const ready = hasTarget
      && this._status === 'ready'
      && this._otherDetails
      && (this._otherDetails.json || this._otherDetails.bundle)
      && !this._otherDetails.error

    let body
    if (!this._baseReady) {
      body = html`<div class="bundle-compare-empty">Loading bundle…</div>`
    } else if (others.length === 0) {
      body = html`<div class="bundle-compare-empty">No other bundles to compare with. Drop a second <code>.map</code> or <code>.stasis.code.br</code> bundle to diff against this one.</div>`
    } else if (!hasTarget) {
      body = html`<div class="bundle-compare-empty">Pick a bundle above to compare against <strong>${this._nameFor(this.integrity)}</strong>.</div>`
    } else if (this._status === 'loading' || !this._otherDetails) {
      body = html`<div class="bundle-compare-empty">Comparing…</div>`
    } else if (this._otherDetails.error) {
      body = html`<div class="bundle-compare-empty is-error">Couldn't read the selected bundle: ${this._otherDetails.error}</div>`
    } else if (!this._otherDetails.json && !this._otherDetails.bundle) {
      body = html`<div class="bundle-compare-empty is-error">The selected bundle couldn't be parsed.</div>`
    } else {
      body = this._renderDiff()
    }

    const code = this._baseReady && ready && this._mode === 'code'
    return html`<div class="bundle-compare">
      <header class="bundle-compare-head">
        ${picker}
        ${this._baseReady && ready ? this._renderSummary(this._diffFor()) : nothing}
      </header>
      ${code ? html`<bundle-compare-code .base=${this.details} .other=${this._otherDetails} .files=${this._diffFor().files} .resolutions=${this._diffFor().resolutions.changed}
          .path=${this._codePath} baseName=${this._nameFor(this.integrity)} otherName=${this._nameFor(this._targetIntegrity)}
          @compare-code-select=${event => { this._codePath = event.detail.path }}></bundle-compare-code>`
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
      ...diff.files.changed.map((r) => r.path),
    ]
    const { prefix, stripped } = stripCommonPathPrefix(allPaths)
    const displayMap = new Map()
    for (let i = 0; i < allPaths.length; i++) displayMap.set(allPaths[i], stripped[i])
    const displayOf = (p) => displayMap.get(p) ?? p

    const hasPkgChanges = diff.packages.onlyOther.length > 0
      || diff.packages.onlyBase.length > 0
      || diff.packages.changed.length > 0

    return html`
      <div class="bundle-compare-caption">
        Changes from <strong>${baseName}</strong> to <strong>${otherName}</strong>
        ${prefix ? html` · <span class="mono">${prefix}</span>` : nothing}
      </div>
      ${this._renderVersionUpdates(diff.versionUpdates, baseName, otherName)}
      ${diff.totals.identical
        ? diff.resolutions.totalChanges > 0
          ? html`<div class="bundle-compare-caption">File contents are unchanged; import resolutions differ.</div>`
          : html`<div class="bundle-compare-identical">These two bundles carry identical files (${diff.totals.unchangedFiles.toLocaleString()} ${diff.totals.unchangedFiles === 1 ? 'file' : 'files'}).</div>`
        : html`
          ${hasPkgChanges ? html`<section class="bundle-compare-section">
            <h3 class="bundle-compare-section-head">Packages</h3>
            <div class="bundle-compare-cols">
              ${this._pkgGroup(`Removed · only in ${baseName}`, diff.packages.onlyBase, 'removed')}
              ${this._pkgGroup(`Added · only in ${otherName}`, diff.packages.onlyOther, 'added')}
              ${this._pkgGroup('Changed size', diff.packages.changed, 'changed')}
            </div>
          </section>` : nothing}
          <section class="bundle-compare-section">
            <h3 class="bundle-compare-section-head">Files</h3>
            <div class="bundle-compare-cols bundle-compare-cols--files">
              ${this._fileGroup(`Removed · only in ${baseName}`, diff.files.onlyBase, 'removed', displayOf)}
              ${this._fileGroup(`Added · only in ${otherName}`, diff.files.onlyOther, 'added', displayOf)}
              ${this._fileGroup('Changed', diff.files.changed, 'changed', displayOf)}
            </div>
          </section>
        `}
      ${this._renderResolutions(diff.resolutions)}
    `
  }
}

customElements.define('bundle-compare', BundleCompare)
