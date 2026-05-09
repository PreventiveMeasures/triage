import { html, render as litRender, nothing } from 'lit'
import { loadRepoUrlFor, saveRepoUrlFor, state } from '../../client/state.js'
import { saveFile } from '../../client/storage.js'
import { upsertWorkspace } from '../../client/workspaces.js'
import { saveTriage } from '../../client/triage.js'
import { analyzeContent, setCount } from '../../client/counts.js'
import { render } from './render.js'
import { toGroup } from './group.js'
import { deriveFindingId } from '../../common/finding-id.js'
import { parseMarkdownFindings } from '../../common/parse-md.js'
import { parseDeepsecFindings } from '../../common/parse-deepsec.js'

// Workspace import — the inverse of workspace-export.js. The dropped
// `.gz` blob is gunzipped, parsed as JSON, validated against the
// export shape (version 1), then unpacked:
//   - the workspace metadata is upserted by id, so re-importing the
//     same workspace merges instead of duplicating;
//   - each `reports[]` entry is written to OPFS verbatim (collisions
//     overwrite, matching saveFile's existing semantics);
//   - the bundled triage is merged into in-memory `state.markers` /
//     `state.deletedIds`. Non-conflicting entries fold in silently;
//     a conflict (the same finding id has different colors locally
//     vs. in the import) raises a modal dialog so the user can pick
//     which side wins per id. Trash status (`deleted`) is purely
//     additive on import — adopting it never undoes a local
//     un-deletion, so it can't conflict on its own;
//   - the bundled per-report `repoUrls` are adopted ONLY for reports
//     that don't already have a URL set locally — so an import never
//     silently clobbers the user's existing entries.
//
// Detection happens upstream in `addFiles` (any `.gz` drop is routed
// here); this module is the place that decides whether the payload
// is actually a workspace and throws if not.

async function gunzipText(file) {
  const buf = await file.arrayBuffer()
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

function isWorkspaceExport(data) {
  return Boolean(
    data
    && typeof data === 'object'
    && data.version === 1
    && data.workspace
    && typeof data.workspace.id === 'string'
    && typeof data.workspace.name === 'string'
    && typeof data.workspace.privateKey === 'string'
    && Array.isArray(data.reports),
  )
}

// Merge the imported triage into state.markers / state.deletedIds /
// state.comments. Non-conflicting changes apply immediately:
//   - new colors / comments (local has none) adopt the imported value;
//   - identical values on both sides are no-ops;
//   - imported `deleted: true` is added to state.deletedIds (additive
//     — the export format never carries `deleted: false`, so an
//     absence on either side just means "no opinion").
// A conflict (both sides have a value and they differ) is collected
// per (id, property) so color and comment can disagree independently
// on the same finding. Each conflict row gets resolved in the modal
// dialog; the local value stays in place until the user decides.
async function mergeTriage(triage, findingLookup) {
  if (!triage || typeof triage !== 'object') return
  // Conflicts are property-scoped — one finding id can disagree on
  // both color and comment, so each gets its own decision in the
  // dialog and its own resolution. Non-conflicting changes apply
  // immediately; the conflicting property stays unchanged locally
  // until the user decides. We collect by `id` and group on the
  // dialog side so each finding only appears once with both
  // conflicts shown together.
  const conflicts = []
  for (const [id, entry] of Object.entries(triage)) {
    if (!entry || typeof entry !== 'object') continue

    const localColor = state.markers.get(id)
    const importedColor = typeof entry.color === 'string' ? entry.color : undefined
    if (importedColor && localColor && localColor !== importedColor) {
      conflicts.push({ id, property: 'color', local: localColor, imported: importedColor })
    } else if (importedColor) {
      state.markers.set(id, importedColor)
    }

    const localComment = state.comments.get(id) ?? ''
    const importedComment = typeof entry.comment === 'string' ? entry.comment : ''
    if (importedComment && localComment && localComment !== importedComment) {
      conflicts.push({ id, property: 'comment', local: localComment, imported: importedComment })
    } else if (importedComment) {
      state.comments.set(id, importedComment)
    }

    const localFix = state.fixes.get(id) ?? ''
    const importedFix = typeof entry.fix === 'string' ? entry.fix : ''
    if (importedFix && localFix && localFix !== importedFix) {
      conflicts.push({ id, property: 'fix', local: localFix, imported: importedFix })
    } else if (importedFix) {
      state.fixes.set(id, importedFix)
    }

    // Triage state — preferred form is `triage: 'fixed'|'invalid'|'deleted'`.
    // Legacy exports only carry `deleted: true`; treat as 'deleted'.
    const importedTriage = (entry.triage === 'fixed' || entry.triage === 'invalid' || entry.triage === 'deleted')
      ? entry.triage
      : (entry.deleted ? 'deleted' : null)
    const localTriage = state.triageState.get(id) ?? null
    if (importedTriage && localTriage && localTriage !== importedTriage) {
      conflicts.push({ id, property: 'triage', local: localTriage, imported: importedTriage })
    } else if (importedTriage && !localTriage) {
      state.triageState.set(id, importedTriage)
    }
    // Per-report ignore — additive merge. Each (reportName, id) is
    // an independent slot; we union the imported list into local.
    // No conflict path here since the keys don't collide between
    // local and imported (a key represents "ignored in this
    // report" — both sides setting it is identical).
    if (Array.isArray(entry.ignoredReports)) {
      for (const r of entry.ignoredReports) {
        if (typeof r === 'string') state.ignoredIds.add(`${r}\0${id}`)
      }
    }
  }
  if (conflicts.length > 0) {
    const decisions = await resolveTriageConflicts(conflicts, findingLookup ?? new Map())
    if (decisions) {
      for (const c of conflicts) {
        const key = `${c.id}:${c.property}`
        if (decisions[key] !== 'imported') continue
        if (c.property === 'color') state.markers.set(c.id, c.imported)
        else if (c.property === 'comment') state.comments.set(c.id, c.imported)
        else if (c.property === 'fix') state.fixes.set(c.id, c.imported)
        else if (c.property === 'triage') state.triageState.set(c.id, c.imported)
      }
    }
  }
  await saveTriage()
}

// Parse the imported reports once to build an `id → { severity,
// file, line, description }` map for the conflict dialog. Same id
// derivation as ingest.js / workspace-export.js so MD-imported
// findings line up with the persisted triage keys. Skipped when
// there's no triage in the import (no conflicts possible). Each
// finding's description gets the first non-empty line trimmed for
// dialog display — full text would blow the modal vertically.
function firstDescriptionLine(text) {
  if (!text) return ''
  for (const line of text.split('\n')) {
    if (line.trim()) return line.trim()
  }
  return ''
}

async function buildFindingLookup(reportEntries) {
  const lookup = new Map()
  for (const r of reportEntries ?? []) {
    if (typeof r?.content !== 'string') continue
    let data
    try {
      data = JSON.parse(r.content)
    } catch {
      data = parseDeepsecFindings(r.content) ?? parseMarkdownFindings(r.content)
    }
    if (!data?.findings) continue
    const all = data.findings.flatMap(toGroup)
    const idLess = all.filter((f) => !f.id)
    if (idLess.length > 0) {
      const computed = await Promise.all(idLess.map(deriveFindingId))
      idLess.forEach((f, i) => { if (computed[i]) f.id = computed[i] })
    }
    for (const f of all) {
      if (!f.id || lookup.has(f.id)) continue
      lookup.set(f.id, {
        severity: f.severity,
        file: f.file,
        line: f.line,
        description: firstDescriptionLine(f.description),
      })
    }
  }
  return lookup
}

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
  let text
  try {
    text = await gunzipText(file)
  } catch (err) {
    throw new Error(`gzip decompression failed: ${err.message}`, { cause: err })
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`payload is not JSON: ${err.message}`, { cause: err })
  }
  if (!isWorkspaceExport(data)) {
    throw new Error('not a deepview workspace export')
  }

  // Save reports first so the workspace's reports[] only references
  // the names that landed successfully.
  const savedNames = []
  for (const r of data.reports) {
    if (typeof r?.name !== 'string' || typeof r?.content !== 'string') continue
    try {
      await saveFile(r.name, r.content)
      const { count, source } = analyzeContent(r.content)
      setCount(r.name, count, source)
      savedNames.push(r.name)
    } catch (err) {
      console.warn(`Workspace import: failed to save ${r.name}: ${err.message}`)
    }
  }

  const ws = upsertWorkspace({
    id: data.workspace.id,
    name: data.workspace.name,
    privateKey: data.workspace.privateKey,
    reports: savedNames,
    createdAt: data.workspace.createdAt,
  })

  // Build a finding metadata lookup up front (once) so the
  // conflict dialog — if any conflicts surface — can show
  // severity badges + file:line + a description preview per
  // conflicting finding instead of a bare uuid prefix. Skipped
  // when there's no triage to merge: no conflicts are possible.
  const hasIncomingTriage = data.triage && Object.keys(data.triage).length > 0
  const lookup = hasIncomingTriage
    ? await buildFindingLookup(data.reports)
    : new Map()
  await mergeTriage(data.triage, lookup)
  // Mutating state.markers / state.deletedIds outside a render
  // context doesn't auto-trigger a repaint of the loaded report —
  // re-run render() so adopted colors and trash assignments show up
  // immediately. No-op when nothing's loaded (render bails on an
  // empty state.reports). Sidebar refresh is owned by addFiles.
  if (state.currentFile) render()

  // Per-report repo URLs round-trip in `data.repoUrls` (keyed by the
  // OPFS filename). Only adopt entries that map to reports we actually
  // saved AND that have no URL set locally — overwriting the user's
  // existing entry would be surprising. If the imported workspace
  // contains the currently-active report and we adopted its URL, sync
  // `state.repoUrl` so the header chip refreshes immediately.
  const savedSet = new Set(savedNames)
  if (data.repoUrls && typeof data.repoUrls === 'object') {
    for (const [name, url] of Object.entries(data.repoUrls)) {
      if (!savedSet.has(name) || typeof url !== 'string' || !url) continue
      if (loadRepoUrlFor(name)) continue
      saveRepoUrlFor(name, url)
      if (state.currentFile === name) state.repoUrl = url
    }
  }

  return ws
}
