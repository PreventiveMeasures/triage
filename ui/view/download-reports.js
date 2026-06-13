import { downloadBlob } from './dom.js'
import { reportsToCsv } from './csv-export.js'
import { exportFilename, reportsToMarkdown } from './markdown-export.js'

// DOM glue for the "download report" button: serialize `reports` in the
// chosen format and trigger the file download. Kept separate from the
// (pure, DOM-free) serializers in markdown-export.js / csv-export.js so
// those stay unit-testable without a DOM.
//
// `format` ∈ {'md','csv'} (default 'md'); `all` bypasses the active
// filters and triage bucket — the dialog's "export everything" toggle
// (see reportGroupsForExport).
export function downloadReports(reports, { format = 'md', all = false } = {}) {
  if (reports.length === 0) return
  if (format === 'csv') {
    const csv = reportsToCsv(reports, { all })
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), exportFilename(reports, 'csv'))
  } else {
    const md = reportsToMarkdown(reports, { all })
    downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), exportFilename(reports, 'md'))
  }
}
