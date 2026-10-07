import { parseLinkedFindings } from '../../client/linked-findings.js'
import { detectFormat, loadFindings, parseCodexCsvToScans, readReport, reportRepoGithub } from '@preventive/report'

// A managed blob retains one server identity even when a CSV contains several
// scans. Keep all their findings (and upstream ids) under that identity. CSV
// repository columns describe findings, not an embedded report-level location.
export function readManagedReport(content: string, filename: string): ReturnType<typeof readReport> {
  const links = content.trimStart().startsWith('[') ? parseLinkedFindings(content) : null
  if (links) return { data: { source: 'links', findings: [], links: links.groups }, format: 'links', reason: null }
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

// Source access follows individual visible members, not their shared finding
// IDs: another member with the same ID can cite files the viewer cannot see.
export function managedFindingSourcePaths(findings: unknown[]): Set<string> {
  const paths = new Set<string>()
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue
    const f = finding as { file?: unknown; evidence?: { file?: unknown }[] }
    if (typeof f.file === 'string' && f.file) paths.add(f.file)
    for (const evidence of Array.isArray(f.evidence) ? f.evidence : []) {
      if (typeof evidence?.file === 'string' && evidence.file) paths.add(evidence.file)
    }
  }
  return paths
}

// Findings name the repository of their own file. Like the local report view,
// a report without its own repository belongs to the one repository named by
// its findings outside dependency directories (Claude Security and Codex
// exports name one on every finding).
const DEPENDENCY_PATH_RE = /(?:^|\/)(?:node_modules|vendor)\//u
export function findingsRepository(findings: unknown[]): string | null {
  const repos = new Map<string, string>()
  for (const finding of findings) {
    const github = reportRepoGithub(finding)
    const file = (finding as { file?: unknown } | null)?.file
    if (github && !(typeof file === 'string' && DEPENDENCY_PATH_RE.test(file))) repos.set(github.toLowerCase(), github)
  }
  return repos.size === 1 ? [...repos.values()][0]! : null
}
