import { state, loadRepoUrlFor, saveRepoUrlFor } from './state.js'
import { saveFile } from './storage.js'
import { upsertWorkspace } from './workspaces.js'
import { saveTriage } from './triage.js'
import { setCount, analyzeContent } from './counts.js'
import { render } from './render.js'

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

// Merge the imported triage into state.markers / state.deletedIds.
// Non-conflicting changes apply immediately:
//   - new colors (local has none) adopt the imported color;
//   - identical colors are no-ops;
//   - imported `deleted: true` is added to state.deletedIds (additive
//     — the export format never carries `deleted: false`, so an
//     absence on either side just means "no opinion").
// A color conflict (both sides have a color and they differ) is
// collected and resolved via the modal dialog; the local value stays
// in place until the user decides.
async function mergeTriage(triage) {
  if (!triage || typeof triage !== 'object') return
  const conflicts = []
  for (const [id, entry] of Object.entries(triage)) {
    if (!entry || typeof entry !== 'object') continue
    const localColor = state.markers.get(id)
    const importedColor = typeof entry.color === 'string' ? entry.color : undefined
    if (importedColor && localColor && localColor !== importedColor) {
      conflicts.push({
        id,
        localColor,
        importedColor,
        localDeleted: state.deletedIds.has(id),
        importedDeleted: Boolean(entry.deleted),
      })
    } else if (importedColor) {
      state.markers.set(id, importedColor)
    }
    if (entry.deleted) state.deletedIds.add(id)
  }
  if (conflicts.length > 0) {
    const decisions = await resolveColorConflicts(conflicts)
    if (decisions) {
      for (const c of conflicts) {
        if (decisions[c.id] === 'imported') state.markers.set(c.id, c.importedColor)
      }
    }
  }
  await saveTriage()
}

// Modal dialog for color conflicts. Renders one row per conflicting
// finding id with a "Keep local" / "Use imported" radio pair plus
// bulk shortcuts. Returns a Map-like object keyed by finding id with
// the user's choice, or null if the dialog was cancelled (in which
// case all conflicts default to "Keep local"). Uses native <dialog>
// for the focus-trap + Esc-to-cancel semantics — no extra JS.
// Same `oklch` values color-marker.js uses, kept in sync so the
// dialog's chip matches the in-app picker. Only the four marker
// colors round-trip in triage.
const COLOR_HEX = {
  red: 'oklch(0.68 0.20 25)',
  blue: 'oklch(0.72 0.15 240)',
  green: 'oklch(0.74 0.15 145)',
  gray: 'oklch(0.55 0.01 260)',
}

function colorChip(color) {
  const value = COLOR_HEX[color] ?? 'transparent'
  return `<span class="conflict-chip" style="background:${value}" title="${color}"></span>${color}`
}

function resolveColorConflicts(conflicts) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'workspace-conflict-dialog'
    const rowsHtml = conflicts.map((c) => `
      <li class="conflict-row" data-id="${c.id}">
        <code class="conflict-id" title="${c.id}">${c.id.slice(0, 8)}…</code>
        <label class="conflict-choice">
          <input type="radio" name="conflict-${c.id}" value="local" checked>
          <span>Keep local: ${colorChip(c.localColor)}${c.localDeleted ? ' <em>(in trash)</em>' : ''}</span>
        </label>
        <label class="conflict-choice">
          <input type="radio" name="conflict-${c.id}" value="imported">
          <span>Use imported: ${colorChip(c.importedColor)}${c.importedDeleted ? ' <em>(in trash)</em>' : ''}</span>
        </label>
      </li>
    `).join('')
    dialog.innerHTML = `
      <h3>Workspace import: triage conflicts</h3>
      <p>The imported workspace differs from your local triage on
        ${conflicts.length} finding${conflicts.length === 1 ? '' : 's'}.
        Pick which color to keep — trash status was already merged.</p>
      <div class="conflict-bulk">
        <button type="button" data-bulk="local">Keep all local</button>
        <button type="button" data-bulk="imported">Use all imported</button>
      </div>
      <ul class="conflict-list">${rowsHtml}</ul>
      <div class="conflict-actions">
        <button type="button" data-action="cancel">Cancel</button>
        <button type="button" data-action="apply" class="primary">Apply</button>
      </div>
    `
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
          const checked = dialog.querySelector(`input[name="conflict-${c.id}"]:checked`)
          decisions[c.id] = checked?.value ?? 'local'
        }
        finish(decisions)
        return
      }
      if (e.target.closest('[data-action="cancel"]')) finish(null)
    })
    // Esc / backdrop close → cancel = keep all local.
    dialog.addEventListener('close', () => finish(null))
    dialog.showModal()
  })
}

export async function importWorkspaceFromGzip(file) {
  let text
  try {
    text = await gunzipText(file)
  } catch (err) {
    throw new Error(`gzip decompression failed: ${err.message}`)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`payload is not JSON: ${err.message}`)
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

  await mergeTriage(data.triage)
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
