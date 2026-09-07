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
// Only the first path in `relevant_paths` becomes `f.file` (some
// findings list several, as `path1 | path2 | …`); the rest are dropped.

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
  while (rows.length > 0 && rows.at(-1).length === 1 && rows.at(-1)[0] === '') rows.pop()
  return rows
}

// Rows as `{ <column>: value }` records keyed by the header row, so the
// mapping below reads columns by name; a column the file lacks reads as
// undefined, a cell a short row lacks as ''. Null-prototype so a column
// named `constructor` can't alias an inherited key.
function csvRecords(header, rows) {
  return rows.map((cells) => {
    const record = Object.create(null)
    header.forEach((name, i) => { record[name] = cells[i] ?? '' })
    return record
  })
}

// Parse + split + convert. Returns one entry per scan:
//   { displayName, data: { type, source, findings: [...] } }
// where `data` is the same shape ingest.js consumes from JSON.
export function parseCodexCsvToScans(text) {
  const rows = parseCsvRows(text)
  if (rows.length < 2) throw new Error('Codex CSV: empty or missing header row')
  const [header, ...body] = rows
  for (const required of REQUIRED_COLUMNS) {
    if (!header.includes(required)) throw new Error(`Codex CSV: missing required column "${required}"`)
  }

  // Group rows by configured_scan_id; a row without one (a blank line
  // included) is skipped.
  const byScan = new Map()
  for (const record of csvRecords(header, body)) {
    const scanId = record.configured_scan_id
    if (!scanId) continue
    if (!byScan.has(scanId)) byScan.set(scanId, [])
    byScan.get(scanId).push(record)
  }
  if (byScan.size === 0) throw new Error('Codex CSV: no rows with a configured_scan_id')

  const scans = []
  for (const [scanId, records] of byScan) {
    // Each scan must belong to a single repository — surface a real
    // error if upstream ever merges scans across repos rather than
    // silently lumping them under one display name.
    const repos = new Set(records.map((r) => r.repository).filter(Boolean))
    if (repos.size > 1) {
      throw new Error(`Codex CSV: scan ${scanId} contains multiple repositories: ${[...repos].join(', ')}`)
    }
    const repo = [...repos][0] || 'unknown-repo'
    // Display name: `${repo}:${scanIdSuffix}`. The suffix is whatever
    // follows the first `:` in configured_scan_id (typical id shape is
    // something like `uuid:<github-id>` — strip the discriminator
    // prefix and keep the human-meaningful id).
    const displayName = `${repo}:${scanId.replace(/^[^:]+:/u, '')}`
    scans.push({
      displayName,
      data: { type: 'security', source: 'codex-security', findings: records.map(rowToFinding) },
    })
  }
  return scans
}

function rowToFinding(r) {
  // First non-empty path only; the siblings of a `path1 | path2 | …`
  // list are dropped.
  const file = r.relevant_paths.split(' | ').map((s) => s.trim()).find(Boolean) || 'unknown'

  // Title + description joined with a blank line so the table view's
  // first-line title shows the headline and the expanded view shows
  // the full body.
  const description = [r.title, r.description].filter(Boolean).join('\n\n')

  const finding = {
    // finding_url is unique per upstream finding — use it directly so
    // triage (markers / deletions) keys off the stable URL and
    // persists across reloads. The triage saver was loosened to
    // accept any non-numeric id (URLs included), see triage.js.
    id: r.finding_url,
    file,
    // Codex CSVs lack line numbers — '?' is the same placeholder
    // markdown findings use when the source has no `#L<n>` anchor.
    line: '?',
    severity: (r.severity || 'medium').toLowerCase(),
    description,
    repo: { github: r.repository },
    // No per-finding `type` here — the codex CSV doesn't carry a
    // category column, and stamping a synthetic 'security' on every
    // row used to make the run-meta line read "security" on every
    // finding even though there's nothing categorical to differentiate
    // them. The renderer already suppresses an empty run-meta
    // (filter(Boolean) → '' → no <span>), so leaving this off is the
    // cleanest result. data.type at the report level still keeps a
    // sensible 'security' default for document.title.
  }
  if (r.commit_hash) finding.commitHash = r.commit_hash
  if (r.detected_at) finding.detectedAt = r.detected_at
  if (r.committed_at) finding.committedAt = r.committed_at
  return finding
}
