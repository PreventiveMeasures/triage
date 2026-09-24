import { detectFormat, loadFindings, parseCodexCsvToScans, readReport } from '../../report/index.js'

// A managed blob retains one server identity even when a CSV contains several
// scans. Keep all their findings (and upstream ids) under that identity. CSV
// repository columns describe findings, not an embedded report-level location.
export function readManagedReport(content: string, filename: string): ReturnType<typeof readReport> {
  const parsed = readReport(content)
  // Permission-filtered responses can be JSON under the original CSV filename.
  if (parsed.data != null || detectFormat(content, filename) !== 'codex') return parsed
  try {
    const scans = parseCodexCsvToScans(content)
    return {
      data: { type: 'security', source: 'codex-security', findings: scans.flatMap((scan) => scan.data.findings) },
      format: 'codex', reason: null,
    }
  } catch (err) {
    return { data: null, format: null, reason: err instanceof Error ? err.message : 'Invalid Codex CSV' }
  }
}

export function loadManagedFindings(content: string, filename: string): ReturnType<typeof loadFindings> {
  const parsed = readManagedReport(content, filename)
  return parsed.data == null ? Promise.resolve(null) : loadFindings(JSON.stringify(parsed.data))
}
