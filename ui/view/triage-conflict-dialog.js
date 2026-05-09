import { html, render as litRender, nothing } from 'lit'

// Modal dialog for per-property triage conflicts. Shared by
// `ui/view/workspace-import.js` (workspace import path) and
// `ui/view/hydration-conflict.js` (report-attach hydration path).
//
// Conflicts are grouped by finding id so each card shows the
// finding's context (severity badge, file:line, first line of
// description) once and lists the per-property choices (color,
// comment, fix, triage) inside it. Returns a map keyed by
// `${id}:${property}` with `'local'` / `'imported'`, or null if
// the dialog was cancelled (= keep local everywhere). Uses native
// <dialog> for focus-trap + Esc-to-cancel; Lit `render` so all
// interpolated text escapes automatically.

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

const DEFAULT_LABELS = {
  title: 'Triage conflicts',
  intro: 'disagree with your local triage on',
  trailingNote: '',
  applyButton: 'Apply',
  importedSideLabel: 'Apply imported',
}

// `findingLookup` is `Map<id, { severity, file, line, description }>`.
// `labels` overrides the default copy: { title, intro, trailingNote,
// applyButton, importedSideLabel }. The defaults read like the
// generic "triage conflicts" wording; pass labels to specialise for
// "import bundle" vs "report attach".
export function resolveTriageConflicts(conflicts, findingLookup, labels = {}) {
  const lbl = { ...DEFAULT_LABELS, ...labels }
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
    // first, then comment, then fix, then triage — matches the
    // action-row ordering in the finding card.
    const PROP_ORDER = { color: 0, comment: 1, fix: 2, triage: 3 }
    for (const list of byId.values()) {
      list.sort((a, b) => (PROP_ORDER[a.property] ?? 99) - (PROP_ORDER[b.property] ?? 99))
    }

    const colorN = conflicts.filter((c) => c.property === 'color').length
    const commentN = conflicts.filter((c) => c.property === 'comment').length
    const fixN = conflicts.filter((c) => c.property === 'fix').length
    const triageN = conflicts.filter((c) => c.property === 'triage').length
    const summary = [
      colorN ? `${colorN} color${colorN === 1 ? '' : 's'}` : '',
      commentN ? `${commentN} comment${commentN === 1 ? '' : 's'}` : '',
      fixN ? `${fixN} fix${fixN === 1 ? '' : 'es'}` : '',
      triageN ? `${triageN} triage state${triageN === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(', ')
    const findingsLabel = `${byId.size} finding${byId.size === 1 ? '' : 's'}`

    litRender(html`
      <header class="conflict-head">
        <h3>${lbl.title}</h3>
        <p>${findingsLabel} ${lbl.intro} ${summary}.${lbl.trailingNote ? ` ${lbl.trailingNote}` : ''}</p>
        <div class="conflict-bulk">
          <button type="button" data-bulk="local">Keep all current</button>
          <button type="button" data-bulk="imported">${lbl.importedSideLabel} (all)</button>
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
                    <span class="conflict-choice-label">${lbl.importedSideLabel}</span>
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
        <button type="button" data-action="apply" class="primary">${lbl.applyButton}</button>
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
