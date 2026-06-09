// `<bundle-compare>` — the Compare slide in the bundles view. Picks a
// second bundle and diffs it against the currently-open one: which
// source files were added / removed / changed, the per-package size
// shifts, and the net byte/file delta. The headline use case is two
// builds of the same artifact ("what did this dependency bump pull
// in?"), but it works on any two bundles the user has on disk.
//
// Light DOM (like `<bundle-treemap>`) so the global report.css rules
// apply AND a click on a file row reaches the document-level
// `[data-bundle-view-source]` delegate in events.js — opening that
// file in the source viewer, exactly like the Files tab / Code slide.
// Only files present in the OPEN bundle carry that hook (removed /
// changed rows); "added" rows live only in the other bundle, whose
// bytes aren't loaded into `state.bundleDetails`, so they render
// static.
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
import { live } from 'lit/directives/live.js'
import { repeat } from 'lit/directives/repeat.js'
import { styleMap } from 'lit/directives/style-map.js'
import { state } from '#client/index.js'
import { formatBytes, stripCommonPathPrefix } from './format.js'
import { pkgColor } from './graph/utils.js'
import { bundlePkgOf } from './bundle-pkg-of.js'
import { bundlePackageDirs, bundleSourcesAsMap } from './bundle-sources.js'
import { buildBundleDetails } from './bundle-load.js'
import { computeBundleDiff } from './bundle-compare-diff.js'

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
// `{ base, target }`, consumed once by willUpdate when integrity flips
// to `base`.
let _pendingSwap = null

// Signed byte count for a delta cell: `+1,234 B` / `−1,234 B` / `±0 B`.
// Uses a real minus (−) to match the typographic style elsewhere in
// the chrome and so it never reads as a hyphen in a path.
function formatDelta(n) {
  if (n === 0) return '±0 B'
  const sign = n > 0 ? '+' : '−'
  return `${sign}${Math.abs(n).toLocaleString()} B`
}

// Percent change of a byte delta against the base total. Empty when
// the base is zero (every byte is new, so a percentage is meaningless).
function formatPct(delta, baseBytes) {
  if (!baseBytes) return ''
  const pct = (delta / baseBytes) * 100
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±'
  return `${sign}${Math.abs(pct).toFixed(1)}%`
}

// `__own__` is the size-distribution / treemap sentinel for own-source
// (non-dependency) files; spell it out in the package lists.
function pkgLabel(pkg) {
  return pkg === '__own__' ? 'own source' : pkg
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
    // Diff memo — recomputed only when the (base, other) integrity
    // pair changes, so unrelated re-renders don't re-walk every file.
    this._diff = null
    this._diffKey = null
  }

  willUpdate(changed) {
    // Reset only when the BASE bundle itself changes (integrity). A
    // details object swapped in for the SAME integrity — the parse
    // landing after a navigation, or fileHashes attaching in place — is
    // the same content, so the comparison stays valid; resetting there
    // would wipe the target the instant the base finished loading.
    if (!changed.has('integrity')) return
    // A swap navigates to the old comparison target as the new base; in
    // that single case restore the old base as the new target instead
    // of clearing it (the module-level handoff survives the prop
    // teardown the navigation triggers).
    if (_pendingSwap && this.integrity === _pendingSwap.base) {
      const target = _pendingSwap.target
      _pendingSwap = null
      this._targetIntegrity = target
      this._otherDetails = null
      this._status = 'loading'
      this._diff = null
      this._diffKey = null
      this._loadOther(target)
      return
    }
    this._targetIntegrity = null
    this._otherDetails = null
    this._status = 'idle'
    this._diff = null
    this._diffKey = null
  }

  // Swap A and B: open the current comparison target as the active
  // bundle (so the app navigates to it) and flip the comparison to the
  // old base. The pending-swap slot carries the new target across the
  // base change; events.js handles the actual bundle switch off the
  // dispatched event (same path the sidebar row click takes).
  _swap() {
    const newBase = this._targetIntegrity
    if (!newBase || newBase === this.integrity) return
    if (!(state.bundles ?? []).some((b) => b.integrity === newBase)) return
    _pendingSwap = { base: newBase, target: this.integrity }
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
  _onPick(e) {
    const integrity = e.target.value || null
    this._targetIntegrity = integrity
    this._otherDetails = null
    this._diff = null
    this._diffKey = null
    if (!integrity) { this._status = 'idle'; return }
    this._status = 'loading'
    this._loadOther(integrity)
  }

  async _loadOther(integrity) {
    const entry = (state.bundles ?? []).find((b) => b.integrity === integrity)
    if (!entry) { this._status = 'idle'; this._targetIntegrity = null; return }
    const details = await buildBundleDetails(integrity, entry)
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

  // A row for one file. `clickable` rows (present in the open bundle)
  // get the source-viewer hook; "added" rows (only in the other
  // bundle) render static since their bytes aren't loaded here.
  _fileRow(path, label, clickable, sizeTpl) {
    const inner = html`<span class="bundle-compare-row-path mono">${label}</span>${sizeTpl}`
    return clickable
      ? html`<li><button
          type="button"
          class="bundle-compare-row bundle-compare-row-link"
          data-bundle-view-source=${path}
          title=${path}
        >${inner}</button></li>`
      : html`<li><div class="bundle-compare-row" title=${path}>${inner}</div></li>`
  }

  // One file group (added / removed / changed). `kind` drives the
  // accent class; `clickable` flags whether rows open in the source
  // viewer. Returns `nothing` for an empty group so the section only
  // shows what actually moved.
  _fileGroup(title, rows, kind, clickable, displayOf) {
    if (rows.length === 0) return nothing
    const shown = rows.slice(0, MAX_ROWS)
    const hidden = rows.length - shown.length
    return html`<section class=${`bundle-compare-group bundle-compare-${kind}`}>
      <header class="bundle-compare-group-head">
        <span class="bundle-compare-dot" aria-hidden="true"></span>
        <span class="bundle-compare-group-title">${title}</span>
        <span class="bundle-compare-group-count">${rows.length}</span>
      </header>
      <ul class="bundle-compare-rows">
        ${repeat(shown, (r) => r.path, (r) => {
          const sizeTpl = r.delta === undefined
            ? html`<span class="bundle-compare-row-size">${formatBytes(r.bytes)}</span>`
            : html`<span class="bundle-compare-row-size">${formatBytes(r.baseBytes)} → ${formatBytes(r.otherBytes)}</span>
                <span class=${`bundle-compare-row-delta ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}`}>${formatDelta(r.delta)}</span>`
          return this._fileRow(r.path, displayOf(r.path), clickable, sizeTpl)
        })}
      </ul>
      ${hidden > 0 ? html`<div class="bundle-compare-more">and ${hidden.toLocaleString()} more…</div>` : nothing}
    </section>`
  }

  // One package group. Same accent scheme as the file groups; rows
  // carry the package color dot for continuity with the size
  // distribution + treemap.
  _pkgGroup(title, rows, kind) {
    if (rows.length === 0) return nothing
    const shown = rows.slice(0, MAX_ROWS)
    const hidden = rows.length - shown.length
    return html`<section class=${`bundle-compare-group bundle-compare-${kind}`}>
      <header class="bundle-compare-group-head">
        <span class="bundle-compare-dot" aria-hidden="true"></span>
        <span class="bundle-compare-group-title">${title}</span>
        <span class="bundle-compare-group-count">${rows.length}</span>
      </header>
      <ul class="bundle-compare-rows">
        ${repeat(shown, (r) => r.pkg, (r) => {
          const sizeTpl = r.delta === undefined
            ? html`<span class="bundle-compare-row-size">${formatBytes(r.bytes)}</span>`
            : html`<span class="bundle-compare-row-size">${formatBytes(r.baseBytes)} → ${formatBytes(r.otherBytes)}</span>
                <span class=${`bundle-compare-row-delta ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}`}>${formatDelta(r.delta)}</span>`
          return html`<li><div class="bundle-compare-row" title=${pkgLabel(r.pkg)}>
            <span class="bundle-compare-pkg-dot" style=${styleMap({ background: pkgColor(r.pkg) })}></span>
            <span class="bundle-compare-row-path">${pkgLabel(r.pkg)}</span>
            ${sizeTpl}
          </div></li>`
        })}
      </ul>
      ${hidden > 0 ? html`<div class="bundle-compare-more">and ${hidden.toLocaleString()} more…</div>` : nothing}
    </section>`
  }

  // Compute (or reuse the memo of) the diff for the current pairing.
  _diffFor() {
    const key = `${this.integrity}|${this._targetIntegrity}`
    if (this._diffKey !== key || !this._diff) {
      const baseSources = bundleSourcesAsMap(this.details)
      const otherSources = bundleSourcesAsMap(this._otherDetails)
      // Bucket packages on prefix-stripped paths so own-source files
      // land under the same name the Overview / Treemap / Graph tabs
      // show — those strip the shared build-output root before
      // bundlePkgOf, so a raw path would bucket `dist/src/x` under `dist`
      // here vs `src` there. The prefix spans BOTH bundles so the two
      // sides align; node_modules / dependencies buckets are unaffected
      // (their marker is matched anywhere in the path).
      //
      // Stasis bundles carry authoritative package boundaries, so feed
      // each path's package dir through too — matching those tabs,
      // workspace packages like `vendor/aws/aws-crt-php` stay separate
      // instead of collapsing under their shared `vendor` parent. The
      // dir is looked up by the ORIGINAL path (the maps are keyed
      // pre-strip) while the stripped path drives own-source bucketing;
      // both sides' maps are merged so a path resolves whichever bundle
      // carries it. Null for sourcemap pairs → heuristic-only, as before.
      const { prefix } = stripCommonPathPrefix([...baseSources.keys(), ...otherSources.keys()])
      const baseDirs = bundlePackageDirs(this.details)
      const otherDirs = bundlePackageDirs(this._otherDetails)
      const packageDirs = baseDirs || otherDirs
        ? new Map([...(baseDirs ?? []), ...(otherDirs ?? [])])
        : null
      const pkgOf = (p) => bundlePkgOf(
        prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p,
        { packageDir: packageDirs?.get(p) },
      )
      this._diff = computeBundleDiff(baseSources, otherSources, pkgOf)
      this._diffKey = key
    }
    return this._diff
  }

  // Summary band — file + size deltas plus the four bucket chips. Sits
  // under the picker once a comparison is live.
  _renderSummary(totals) {
    return html`<div class="bundle-compare-summary">
      <div class="bundle-compare-metric">
        <span class="bundle-compare-metric-label">Files</span>
        <span class="bundle-compare-metric-value">${totals.baseFiles.toLocaleString()} → ${totals.otherFiles.toLocaleString()}</span>
        <span class=${`bundle-compare-metric-delta ${totals.fileDelta > 0 ? 'up' : totals.fileDelta < 0 ? 'down' : ''}`}>${totals.fileDelta === 0 ? '±0' : `${totals.fileDelta > 0 ? '+' : '−'}${Math.abs(totals.fileDelta).toLocaleString()}`}</span>
      </div>
      <div class="bundle-compare-metric">
        <span class="bundle-compare-metric-label">Size</span>
        <span class="bundle-compare-metric-value">${formatBytes(totals.baseBytes)} → ${formatBytes(totals.otherBytes)}</span>
        <span class=${`bundle-compare-metric-delta ${totals.byteDelta > 0 ? 'up' : totals.byteDelta < 0 ? 'down' : ''}`}>${formatDelta(totals.byteDelta)}${(() => { const p = formatPct(totals.byteDelta, totals.baseBytes); return p ? html`${' '}<span class="bundle-compare-pct">(${p})</span>` : nothing })()}</span>
      </div>
      <div class="bundle-compare-chips">
        <span class="bundle-compare-chip removed">−${totals.onlyBaseFiles.toLocaleString()} removed</span>
        <span class="bundle-compare-chip added">+${totals.onlyOtherFiles.toLocaleString()} added</span>
        <span class="bundle-compare-chip changed">${totals.changedFiles.toLocaleString()} changed</span>
        <span class="bundle-compare-chip unchanged">${totals.unchangedFiles.toLocaleString()} unchanged</span>
      </div>
    </div>`
  }

  _renderPicker(others, hasTarget) {
    const baseName = this._nameFor(this.integrity)
    return html`<div class="bundle-compare-picker">
      <span class="bundle-compare-base" title=${baseName}>${baseName}</span>
      <span class="bundle-compare-arrow" aria-hidden="true">→</span>
      <label class="bundle-compare-select-wrap">
        <span class="bundle-compare-select-hint">Compare with</span>
        <select
          class="bundle-compare-select"
          .value=${live(this._targetIntegrity ?? '')}
          @change=${(e) => this._onPick(e)}
          aria-label="Bundle to compare with"
        >
          <option value="">Choose a bundle…</option>
          ${others.map((o) => html`<option value=${o.integrity}>${o.label}</option>`)}
        </select>
      </label>
      ${hasTarget ? html`<button
        type="button"
        class="bundle-compare-swap"
        @click=${() => this._swap()}
        aria-label="Swap the two bundles"
      ><span class="bundle-compare-swap-icon" aria-hidden="true">↔</span>Swap</button>` : nothing}
    </div>`
  }

  // Build the picker option list, disambiguating duplicate names with a
  // short integrity suffix so two same-named bundles are tellable apart.
  _otherOptions() {
    const others = (state.bundles ?? []).filter((b) => b.integrity !== this.integrity)
    const nameCounts = new Map()
    for (const b of others) nameCounts.set(b.name, (nameCounts.get(b.name) ?? 0) + 1)
    return others.map((b) => ({
      integrity: b.integrity,
      label: nameCounts.get(b.name) > 1
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
    // Picker is always present (when there's anything to pick) so the
    // user can switch the compared bundle without leaving the tab; the
    // swap button rides in it, shown only once a target is live.
    const picker = others.length > 0 ? this._renderPicker(others, hasTarget) : nothing
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

    return html`<div class="bundle-compare">
      <header class="bundle-compare-head">
        ${picker}
        ${this._baseReady && ready ? this._renderSummary(this._diffFor().totals) : nothing}
      </header>
      <div class="bundle-compare-body">${body}</div>
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
      ${diff.totals.identical
        ? html`<div class="bundle-compare-identical">These two bundles carry identical sources (${diff.totals.unchangedFiles.toLocaleString()} ${diff.totals.unchangedFiles === 1 ? 'file' : 'files'}).</div>`
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
              ${this._fileGroup(`Removed · only in ${baseName}`, diff.files.onlyBase, 'removed', true, displayOf)}
              ${this._fileGroup(`Added · only in ${otherName}`, diff.files.onlyOther, 'added', false, displayOf)}
              ${this._fileGroup('Changed', diff.files.changed, 'changed', true, displayOf)}
            </div>
          </section>
        `}
    `
  }
}

customElements.define('bundle-compare', BundleCompare)
