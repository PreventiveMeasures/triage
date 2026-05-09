// Codex Security CSV parser. Input is a multi-scan CSV export with
// rows like:
//   finding_url,repository,repository_url,title,description,severity,
//   status,detected_at,committed_at,author_email,assignee_name,
//   assignee_email,has_patch,configured_scan_id,commit_hash,
//   relevant_paths,resolution_reason
// One CSV typically merges several scans (each `configured_scan_id`
// is one scan). We split on that field and emit one report per scan.
//
// Display name per scan: `${repository}:${configured_scan_id stripped
// of its `<prefix>:` head}`. Each scan must contain exactly one
// repository — asserted, not silently merged.
//
// First-pass: only the first path in `relevant_paths` is used as
// `f.file` (some findings list multiple `path1 | path2 | …`); a
// follow-up commit will surface the rest.

const REQUIRED_COLUMNS = [
  'finding_url', 'repository', 'title', 'description', 'severity',
  'configured_scan_id', 'relevant_paths',
]

// RFC 4180-ish CSV parser: handles quoted fields containing commas,
// embedded newlines, and `""` escaped quotes. Returns rows as arrays
// of strings (no header / object conversion — caller picks columns by
// index from the header row).
function parseCsvRows(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuote = false
  const n = text.length
  for (let i = 0; i < n; i++) {
    const c = text[i]
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else { inQuote = false }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuote = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      row.push(field); rows.push(row); row = []; field = ''
      if (c === '\r' && text[i + 1] === '\n') i++
    } else {
      field += c
    }
  }
  // Trailing field / row (no final newline).
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  // Strip purely-empty trailing rows that come from a trailing newline.
  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop()
  return rows
}

// Parse + split + convert. Returns one entry per scan:
//   { displayName, data: { type, source, findings: [...] } }
// where `data` is the same shape ingest.js consumes from JSON.
export function parseCodexCsvToScans(text) {
  const rows = parseCsvRows(text)
  if (rows.length < 2) throw new Error('Codex CSV: empty or missing header row')
  const header = rows[0]
  const colIndex = (name) => header.indexOf(name)
  for (const required of REQUIRED_COLUMNS) {
    if (colIndex(required) === -1) {
      throw new Error(`Codex CSV: missing required column "${required}"`)
    }
  }
  const cols = {
    finding_url: colIndex('finding_url'),
    repository: colIndex('repository'),
    title: colIndex('title'),
    description: colIndex('description'),
    severity: colIndex('severity'),
    detected_at: colIndex('detected_at'),
    committed_at: colIndex('committed_at'),
    configured_scan_id: colIndex('configured_scan_id'),
    commit_hash: colIndex('commit_hash'),
    relevant_paths: colIndex('relevant_paths'),
  }

  // Group rows by configured_scan_id.
  const byScan = new Map()
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (r.length === 1 && r[0] === '') continue
    const scanId = r[cols.configured_scan_id]
    if (!scanId) continue
    if (!byScan.has(scanId)) byScan.set(scanId, [])
    byScan.get(scanId).push(r)
  }
  if (byScan.size === 0) throw new Error('Codex CSV: no rows with a configured_scan_id')

  const scans = []
  for (const [scanId, scanRows] of byScan) {
    // Each scan must belong to a single repository — surface a real
    // error if upstream ever merges scans across repos rather than
    // silently lumping them under one display name.
    const repos = new Set(scanRows.map((r) => r[cols.repository]).filter(Boolean))
    if (repos.size > 1) {
      throw new Error(`Codex CSV: scan ${scanId} contains multiple repositories: ${[...repos].join(', ')}`)
    }
    const repo = [...repos][0] || 'unknown-repo'
    // Display name: `${repo}:${scanIdSuffix}`. The suffix is whatever
    // follows the first `:` in configured_scan_id (typical id shape is
    // something like `uuid:<github-id>` — strip the discriminator
    // prefix and keep the human-meaningful id).
    const scanSuffix = scanId.replace(/^[^:]+:/u, '')
    const displayName = `${repo}:${scanSuffix}`

    const findings = scanRows.map((r) => rowToFinding(r, cols))
    scans.push({
      displayName,
      data: { type: 'security', source: 'codex-security', findings },
    })
  }
  return scans
}

function rowToFinding(r, cols) {
  // First non-empty filename only, for now. The next commit will
  // surface multiple `relevant_paths` entries on one finding (some
  // rows list 2-N paths separated by ` | `).
  const file = (r[cols.relevant_paths] || '')
    .split(' | ').map((s) => s.trim()).find(Boolean) || 'unknown'

  // Codex CSVs lack line numbers — '?' is the same placeholder
  // markdown findings use when the source has no `#L<n>` anchor.
  const line = '?'

  // Title + description joined with a blank line so the table view's
  // first-line title shows the headline and the expanded view shows
  // the full body.
  const title = r[cols.title] || ''
  const desc = r[cols.description] || ''
  const description = title && desc ? `${title}\n\n${desc}` : (title || desc)

  const finding = {
    // finding_url is unique per upstream finding — use it directly so
    // triage (markers / deletions) keys off the stable URL and
    // persists across reloads. The triage saver was loosened to
    // accept any non-numeric id (URLs included), see triage.js.
    id: r[cols.finding_url],
    file,
    line,
    severity: (r[cols.severity] || 'medium').toLowerCase(),
    description,
    repo: { github: r[cols.repository] },
    // No per-finding `type` here — the codex CSV doesn't carry a
    // category column, and stamping a synthetic 'security' on every
    // row used to make the run-meta line read "security" on every
    // finding even though there's nothing categorical to differentiate
    // them. The renderer already suppresses an empty run-meta
    // (filter(Boolean) → '' → no <span>), so leaving this off is the
    // cleanest result. data.type at the report level still keeps a
    // sensible 'security' default for document.title.
  }
  if (cols.commit_hash !== -1 && r[cols.commit_hash]) finding.commitHash = r[cols.commit_hash]
  if (cols.detected_at !== -1 && r[cols.detected_at]) finding.detectedAt = r[cols.detected_at]
  if (cols.committed_at !== -1 && r[cols.committed_at]) finding.committedAt = r[cols.committed_at]
  return finding
}
