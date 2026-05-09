import { html, render as litRender, nothing } from 'lit'
import { state } from '../../client/state.js'
import { parseWorkspaceGzip, applyWorkspaceImport } from '../../client/workspace-import.js'
import { render } from './render.js'

// Thin DOM wrapper around the pure import pipeline in
// `client/workspace-import.js`. Drives the conflict-resolution
// dialog (lit + native <dialog> for focus-trap + Esc-to-cancel),
// triggers a re-render after merge, and lets the pure layer do the
// actual state mutation + persistence.
//
// Detection happens upstream in `addFiles` (any `.gz` drop is routed
// here); the pure layer decides whether the payload is actually a
// workspace and throws if not.

// Same `oklch` values color-marker.js uses, kept in sync so the
// dialog's chip matches the in-app picker. Only the four marker
// colors round-trip in triage.
const COLOR_HEX = {
  red: 'oklch(0.68 0.20 25)',
  blue: 'oklch(0.72 0.15 240)',
  green: 'oklch(0.74 0.15 145)',
  gray: 'oklch(0.55 0.01 260)',
}

function colorSwatchTemplate(color) {
  const value = COLOR_HEX[color] ?? 'transparent'
  return html`<span class="conflict-color">
    <span class="conflict-color-dot" style=${`background:${value}`}></span>
    <span class="conflict-color-name">${color}</span>
  </span>`
}

function commentBlockTemplate(text) {
  return html`<span class="conflict-comment-text">${text || html`<em>empty</em>`}</span>`
}

function fixBlockTemplate(text) {
  if (!text) return html`<span class="conflict-comment-text"><em>empty</em></span>`
  return html`<span class="conflict-fix-text"><a href=${text} target="_blank" rel="noopener">${text}</a></span>`
}

function triageBadgeTemplate(value) {
  if (!value) return html`<em>none</em>`
  return html`<span class=${`conflict-triage triage-${value}`}>${value}</span>`
}

function valueTemplate(property, value) {
  if (property === 'color') return colorSwatchTemplate(value)
  if (property === 'comment') return commentBlockTemplate(value)
  if (property === 'fix') return fixBlockTemplate(value)
  if (property === 'triage') return triageBadgeTemplate(value)
  return html`${String(value)}`
}

function severityBadgeTemplate(sev) {
  if (!sev) return nothing
  const label = sev.replace(/_/gu, ' ')
  return html`<span class=${`conflict-sev sev-${sev}`}>${label}</span>`
}

function findingHeaderTemplate(meta, id) {
  const loc = meta?.file
    ? (meta.line ? `${meta.file}:${meta.line}` : meta.file)
    : ''
  return html`
    <div class="conflict-card-head">
      ${severityBadgeTemplate(meta?.severity)}
      ${loc ? html`<span class="conflict-loc" title=${loc}>${loc}</span>` : nothing}
      <code class="conflict-id" title=${id}>${id.slice(0, 8)}…</code>
    </div>
    ${meta?.description
      ? html`<div class="conflict-desc" title=${meta.description}>${meta.description}</div>`
      : nothing}
  `
}

// Modal dialog for triage conflicts. Conflicts are grouped by
// finding id so each card shows the finding's context (severity
// badge, file:line, first line of description) once and lists the
// per-property choices (color, comment) inside it. Returns a map
// keyed by `${id}:${property}` with `'local'` / `'imported'`, or
// null if the dialog was cancelled (which is equivalent to keeping
// local everywhere). Uses native <dialog> for focus-trap +
// Esc-to-cancel — no extra JS — and Lit `render` so all
// interpolated text escapes automatically.
function resolveTriageConflicts(conflicts, findingLookup) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'workspace-conflict-dialog'

    // Group by finding id so a finding with both a color AND a
    // comment conflict shows up as a single card with two
    // decisions, instead of two unrelated rows.
    const byId = new Map()
    for (const c of conflicts) {
      if (!byId.has(c.id)) byId.set(c.id, [])
      byId.get(c.id).push(c)
    }
    // Sort properties within a card so order is stable: color
    // first, then comment, then fix — matches the action-row
    // ordering in the finding card.
    const PROP_ORDER = { color: 0, comment: 1, fix: 2, triage: 3 }
    for (const list of byId.values()) {
      list.sort((a, b) => (PROP_ORDER[a.property] ?? 99) - (PROP_ORDER[b.property] ?? 99))
    }

    const colorN = conflicts.filter((c) => c.property === 'color').length
    const commentN = conflicts.filter((c) => c.property === 'comment').length
    const fixN = conflicts.filter((c) => c.property === 'fix').length
    const summary = [
      colorN ? `${colorN} color${colorN === 1 ? '' : 's'}` : '',
      commentN ? `${commentN} comment${commentN === 1 ? '' : 's'}` : '',
      fixN ? `${fixN} fix${fixN === 1 ? '' : 'es'}` : '',
    ].filter(Boolean).join(', ')
    const findingsLabel = `${byId.size} finding${byId.size === 1 ? '' : 's'}`

    litRender(html`
      <header class="conflict-head">
        <h3>Triage conflicts on import</h3>
        <p>${findingsLabel} disagree with your local triage on
          ${summary}. Pick which side to keep — trash status was
          already merged.</p>
        <div class="conflict-bulk">
          <button type="button" data-bulk="local">Keep all current</button>
          <button type="button" data-bulk="imported">Apply all imported</button>
        </div>
      </header>
      <ul class="conflict-list">
        ${[...byId.entries()].map(([id, items]) => html`
          <li class="conflict-card" data-id=${id}>
            ${findingHeaderTemplate(findingLookup.get(id), id)}
            <div class="conflict-rows">
              ${items.map((c) => {
                const key = `${c.id}:${c.property}`
                const radioName = `conflict-${key}`
                const propLabel = c.property === 'color' ? 'Color'
                  : c.property === 'comment' ? 'Comment'
                  : c.property === 'fix' ? 'Fix'
                  : c.property === 'triage' ? 'Triage state'
                  : c.property
                return html`<div class="conflict-row" data-key=${key}>
                  <span class="conflict-row-label">${propLabel}</span>
                  <label class="conflict-choice">
                    <input type="radio" name=${radioName} value="local" checked>
                    <span class="conflict-choice-label">Keep current</span>
                    <span class="conflict-choice-value">${valueTemplate(c.property, c.local)}</span>
                  </label>
                  <label class="conflict-choice">
                    <input type="radio" name=${radioName} value="imported">
                    <span class="conflict-choice-label">Apply imported</span>
                    <span class="conflict-choice-value">${valueTemplate(c.property, c.imported)}</span>
                  </label>
                </div>`
              })}
            </div>
          </li>
        `)}
      </ul>
      <footer class="conflict-actions">
        <button type="button" data-action="cancel">Cancel</button>
        <button type="button" data-action="apply" class="primary">Apply</button>
      </footer>
    `, dialog)

    document.body.appendChild(dialog)
    let settled = false
    const finish = (decisions) => {
      if (settled) return
      settled = true
      dialog.close()
      dialog.remove()
      resolve(decisions)
    }
    dialog.addEventListener('click', (e) => {
      const bulk = e.target.closest('[data-bulk]')
      if (bulk) {
        const value = bulk.dataset.bulk
        for (const r of dialog.querySelectorAll(`input[type="radio"][value="${value}"]`)) r.checked = true
        return
      }
      if (e.target.closest('[data-action="apply"]')) {
        const decisions = {}
        for (const c of conflicts) {
          const key = `${c.id}:${c.property}`
          const checked = dialog.querySelector(`input[name="conflict-${CSS.escape(key)}"]:checked`)
          decisions[key] = checked?.value ?? 'local'
        }
        finish(decisions)
        return
      }
      if (e.target.closest('[data-action="cancel"]')) finish(null)
    })
    // Esc / backdrop close → cancel = keep all current.
    dialog.addEventListener('close', () => finish(null))
    dialog.showModal()
  })
}

export async function importWorkspaceFromGzip(file) {
  const data = await parseWorkspaceGzip(file)
  const ws = await applyWorkspaceImport(data, { conflictResolver: resolveTriageConflicts })
  // Mutating state.markers / state.triageState outside a render
  // context doesn't auto-trigger a repaint of the loaded report —
  // re-run render() so adopted colors and trash assignments show up
  // immediately. No-op when nothing's loaded (render bails on an
  // empty state.reports). Sidebar refresh is owned by addFiles.
  if (state.currentFile) render()
  return ws
}
