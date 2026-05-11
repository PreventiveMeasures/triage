// One-shot origin check for the legacy view hosts. The production
// view now lives on triage.space; users who land on either
// deepaudit.dev/view.html or chalker.github.io/deepview/view.html
// with no local data are bounced over silently, and users who do
// have local data get a styled modal so they can either follow
// the migration or keep editing in place while they export their
// local state.
//
// What each transfer mechanism actually carries (so the prompt
// doesn't lie about the migration paths):
//
//   triage-sync (deepaudit.dev only)
//     Per-workspace TRIAGE STATE — markers, triage buckets,
//     comments, fixes, per-report ignores. Does NOT carry the
//     workspace record itself (private key + report list) or
//     report content; both still need a manual re-import on the
//     new origin before the synced triage can reattach.
//
//   <workspace-export> (sidebar button on each workspace)
//     A single workspace and its reports + the triage for those
//     reports, in one .gz drop. This is the right move for a
//     non-synced workspace migration: drop the .gz on triage.space
//     and everything appears at once.
//
//   DeepView.export() / <triage-export-dialog>
//     The flat, persisted-id triage table plus saved repo URLs.
//     No reports, no workspaces — strictly the triage payload
//     keyed by finding id. Useful for moving triage attached to
//     loose (unattached) reports, or as a top-up after a
//     workspace re-import.
//
// Modal lives in the same family as `<triage-export-dialog>` /
// `<comment-dialog>`: native <dialog> for focus-trap + Esc-to-
// cancel, light-DOM render so `.origin-migration-dialog` rules in
// sidebar.css apply.

import { LitElement, html } from 'lit'
import { listBundles, listFiles } from '../../client/storage.js'
import { listWorkspaces } from '../../client/workspaces.js'

const TARGET_URL = 'https://triage.space/view.html'

// Hosts that should redirect / prompt. `pathPrefix` gates GitHub
// Pages (where chalker.github.io serves multiple projects under
// their own path) so other repos under the same hostname aren't
// caught by this check. `supportsSync` tailors the prompt: the
// github.io static build has no sync layer, so we don't claim any
// workspace will persist on its own there.
const LEGACY_HOSTS = [
  { hostname: 'deepaudit.dev', pathPrefix: '/', supportsSync: true },
  { hostname: 'chalker.github.io', pathPrefix: '/deepview/', supportsSync: false },
]

function matchedHost() {
  for (const host of LEGACY_HOSTS) {
    if (location.hostname === host.hostname && location.pathname.startsWith(host.pathPrefix)) {
      return host
    }
  }
  return null
}

// localStorage keys that hold user data outside the report/workspace
// stores. Hard-coded here rather than imported because `client/triage.js`
// keeps its key names private; the canonical defs live there
// (`TRIAGE_KEY`, `TRIAGE_PENDING_KEY`) and in `client/state.ts`
// (`REPO_URLS_KEY`). Touch this list whenever those move.
//
//   deepview.triage          compressed triage blob — only present
//                            when at least one entry exists (saveTriage
//                            removes the key on an empty payload).
//   deepview.triage.pending  uncompressed pre-compress snapshot — same
//                            "present ⇒ non-empty" invariant.
//   deepview.repoUrls        per-report repo URL map; written even when
//                            the map empties out, so parse to confirm
//                            it actually contains entries.
const TRIAGE_KEYS = ['deepview.triage', 'deepview.triage.pending']
const REPO_URLS_KEY = 'deepview.repoUrls'

function hasPersistedTriage() {
  try {
    for (const key of TRIAGE_KEYS) {
      if (localStorage.getItem(key)) return true
    }
  } catch { return true }
  try {
    const raw = localStorage.getItem(REPO_URLS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
        return true
      }
    }
  } catch {
    // Corrupt JSON or quota probe failure — treat as data so the
    // user gets the prompt instead of a silent redirect.
    return true
  }
  return false
}

async function hasLocalData() {
  // Default to "has data" on probe failure — a false positive only
  // costs a confirm dialog, while a false negative would silently
  // navigate the user away from data they can't yet see. Triage
  // entries / saved repo URLs count too, because a user can have
  // triage attached to a report they later deleted from OPFS — the
  // entries linger under their finding id and need a DeepView.export()
  // before this tab unloads.
  if (hasPersistedTriage()) return true
  let files = []
  try { files = await listFiles() } catch { return true }
  if (files.length > 0) return true
  try { if (listWorkspaces().length > 0) return true } catch { return true }
  // OPFS-stored sourcemap / stasis bundles also count — they're
  // origin-scoped and have no automatic carry-across (the user has
  // to re-drop the originals on the new origin), so a silent
  // redirect would strip them off the legacy origin with no chance
  // to fish out the integrity hashes / filenames first.
  try { return (await listBundles()).length > 0 } catch { return true }
}

class OriginMigrationDialog extends LitElement {
  static properties = {
    supportsSync: { attribute: false },
  }

  // Light DOM — `.origin-migration-dialog` rules live in sidebar.css
  // next to the other deepview dialogs. A shadow root would hide them.
  createRenderRoot() { return this }

  constructor() {
    super()
    this.supportsSync = false
  }

  firstUpdated() {
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.showModal()
    // Default focus on "Keep editing" so an accidental Enter doesn't
    // navigate the user away from their data. Migration is the
    // explicit-click path.
    const stay = this.querySelector('button.om-stay')
    if (stay) stay.focus()
  }

  _finish(result) {
    if (this._settled) return
    this._settled = true
    const dialog = this.querySelector('dialog')
    if (dialog) dialog.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: result }))
  }

  // Native <dialog> fires `close` for Esc and backdrop — same as
  // cancel ("keep editing"). The explicit Cancel button reuses the
  // path via _onStay.
  _onClose = () => this._finish(false)

  _onStay = () => this._finish(false)
  _onMigrate = () => this._finish(true)

  render() {
    // Destination is rendered as an explicit anchor with
    // target="_blank" so a curious user can pop the new page open
    // without losing their current edits — matches the link
    // conventions elsewhere in ui/view (rel="noopener noreferrer"
    // for external destinations, see fix-link-dialog /
    // triage-conflict-dialog). The current-origin label stays a
    // plain <code> chip since it's just descriptive.
    const target = () => html`<a class="om-link" href=${TARGET_URL} target="_blank" rel="noopener noreferrer">${TARGET_URL}</a>`
    return html`<dialog class="origin-migration-dialog" @close=${this._onClose}>
      <header class="om-head">
        <h3>This deepview build has moved</h3>
        <p>
          <code>${location.host}${location.pathname}</code> has moved to ${target()}.
        </p>
      </header>

      <section class="om-body">
        <p>
          Workspaces and reports don't migrate automatically — they live in this origin's
          browser storage (OPFS where available, localStorage as a fallback) and have to
          be re-imported on ${target()}.
        </p>
        ${this.supportsSync
          ? html`
            <p>
              For each workspace, use the <strong>Export workspace</strong> button in the
              sidebar to download a <code>.gz</code> bundle (workspace + its reports + its
              triage), then drop that file on ${target()}. Workspaces that had sync
              configured will pick their triage state back up from the sync server once
              you re-import them with the same key.
            </p>
            <p>
              For triage attached to loose reports (or as a top-up after re-importing
              workspaces), call <code>DeepView.export()</code> in the browser console —
              that downloads just the triage entries plus saved repo URLs, no reports
              or workspaces.
            </p>
          `
          : html`
            <p>
              This build has no sync layer. For each workspace, use the
              <strong>Export workspace</strong> button in the sidebar to download a
              <code>.gz</code> bundle (workspace + its reports + its triage), then drop
              that file on ${target()}.
            </p>
            <p>
              For triage attached to loose reports, call <code>DeepView.export()</code>
              in the browser console — that downloads just the triage entries plus saved
              repo URLs, no reports or workspaces. Reports themselves need to be
              re-dropped from their original JSON on the new origin.
            </p>
          `}
      </section>

      <footer class="om-actions">
        <button type="button" class="om-stay" @click=${this._onStay}>
          Keep editing on ${location.host}
        </button>
        <button type="button" class="primary om-go" @click=${this._onMigrate}>
          Switch to triage.space
        </button>
      </footer>
    </dialog>`
  }
}

customElements.define('origin-migration-dialog', OriginMigrationDialog)

function openMigrationDialog(host) {
  return new Promise((resolve) => {
    const el = document.createElement('origin-migration-dialog')
    el.supportsSync = host.supportsSync
    el.addEventListener('resolve', (e) => {
      el.remove()
      resolve(Boolean(e.detail))
    })
    document.body.appendChild(el)
  })
}

export async function runLegacyOriginCheck() {
  const host = matchedHost()
  if (!host) return false
  if (!(await hasLocalData())) {
    location.replace(TARGET_URL)
    return true
  }
  const wantsMigrate = await openMigrationDialog(host)
  if (wantsMigrate) {
    location.assign(TARGET_URL)
    return true
  }
  return false
}
