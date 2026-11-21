// One-shot check for the legacy view hosts (deepaudit.dev,
// chalker.github.io/deepview): the view lives on triage.space now. A visitor
// with no local data is redirected silently; one with data gets a modal to
// migrate or keep editing while they export. What carries over, so the
// prompt doesn't lie about it:
//   triage-sync (deepaudit.dev only): per-workspace triage state, not the
//     workspace record or reports, which need re-importing first;
//   <workspace-export>: a workspace, its reports and their triage, one .gz;
//   DeepView.export(): the flat triage table and saved repo URLs only.
// Light DOM, so styles/dialogs.css `.origin-migration-dialog` applies.

import { LitElement, html } from 'lit'
import { hasAnyBundles, listFiles, listWorkspaces } from '#client/index.js'

const TARGET_URL = 'https://triage.space/'

// `pathPrefix` keeps other GitHub Pages projects on the same host out;
// `supportsSync` tailors the prompt (the github.io build has no sync).
const LEGACY_HOSTS = [
  { hostname: 'deepaudit.dev', pathPrefix: '/', supportsSync: true },
  { hostname: 'chalker.github.io', pathPrefix: '/deepview/', supportsSync: false },
]

function matchedHost() {
  return LEGACY_HOSTS.find((host) => location.hostname === host.hostname && location.pathname.startsWith(host.pathPrefix)) ?? null
}

// User data in localStorage beside the report / workspace stores, under
// the names client/triage.js (`TRIAGE_KEY`, `TRIAGE_PENDING_KEY`) and
// client/state.ts (`REPO_URLS_KEY`) keep private — keep in sync. The triage
// keys exist only when non-empty; the repo URL map is written even empty.
const TRIAGE_KEYS = ['deepview.triage', 'deepview.triage.pending']
const REPO_URLS_KEY = 'deepview.repoUrls'

// A failed probe (or corrupt JSON) counts as data throughout: a false
// positive costs a dialog, a false negative navigates away from data the
// user can't see yet.
function hasPersistedTriage() {
  try {
    if (TRIAGE_KEYS.some((key) => localStorage.getItem(key))) return true
    const raw = localStorage.getItem(REPO_URLS_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw)
    return Boolean(parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0)
  } catch {
    return true
  }
}

// Triage on a report since deleted lingers under its finding id, so it
// counts; so do OPFS bundles, which have no automatic carry-across.
async function hasLocalData() {
  if (hasPersistedTriage()) return true
  let files = []
  try { files = await listFiles() } catch { return true }
  if (files.length > 0) return true
  try { if (listWorkspaces().length > 0) return true } catch { return true }
  // Directory entries, not `listBundles()`: this runs before the boot unlock
  // gate, and the encrypted `_meta.json` reads as `[]` while locked.
  try { return await hasAnyBundles() } catch { return true }
}

class OriginMigrationDialog extends LitElement {
  static properties = {
    supportsSync: { attribute: false },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.supportsSync = false
  }

  firstUpdated() {
    this.querySelector('dialog')?.showModal()
    // "Keep editing" takes the focus, so a stray Enter doesn't navigate
    // away from the user's data.
    this.querySelector('button.om-stay')?.focus()
  }

  _finish(result) {
    if (this._settled) return
    this._settled = true
    this.querySelector('dialog')?.close()
    this.dispatchEvent(new CustomEvent('resolve', { detail: result }))
  }

  // Also the dialog's `close` (Esc, backdrop).
  _onStay = () => this._finish(false)
  _onMigrate = () => this._finish(true)

  render() {
    // A new-tab link, so the new page opens without losing current edits.
    const target = () => html`<a class="om-link" href=${TARGET_URL} target="_blank" rel="noopener noreferrer">${TARGET_URL}</a>`
    return html`<dialog class="origin-migration-dialog" @close=${this._onStay}>
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
    document.body.append(el)
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
