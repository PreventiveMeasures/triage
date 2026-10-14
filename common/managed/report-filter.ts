// Apply report permissions before serving findings, triage, or source files.
// Security uses the same complete-row classification as the UI. Dependency
// access is per finding: App, own source, and the own-source organizations stay.
import { inheritReportMeta, isAppFinding, reportRepoGithub, stampSecurityGroups } from '@preventive/report'
import { readManagedReport } from './report-content.ts'

export interface ViewerPermissions {
  dependencies: boolean
  security: boolean
}

type Finding = Record<string, unknown>
function object(value: unknown): Finding | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Finding : null
}
function pathOf(finding: Finding): string {
  return typeof finding['file'] === 'string' ? finding['file'].replaceAll('\\', '/') : ''
}
function isDependency(finding: Finding): boolean {
  return /(?:^|\/)(?:node_modules|vendor|dependencies)(?:\/|$)/u.test(pathOf(finding))
}
function githubOrg(value: unknown): string | null {
  return reportRepoGithub(value)?.split('/')[0]?.toLowerCase() ?? null
}
function npmScope(finding: Finding, fromPath = false): string | null {
  let name = object(object(finding['package'])?.['npm'])?.['name']
  if (typeof name !== 'string' && fromPath) {
    const parts = pathOf(finding).split('/')
    for (let i = parts.length - 3; i >= 0; i--) {
      if (['node_modules', 'vendor', 'dependencies'].includes(parts[i]!)) {
        name = `${parts[i + 1]}/${parts[i + 2]}`
        break
      }
    }
  }
  return typeof name === 'string' ? /^(@[^/\s]+)\/[^/\s]+$/u.exec(name)?.[1] ?? null : null
}

// Links as the security graph reads them. A star per link is enough for
// transitive propagation, without a quadratic expansion for large links.
export function linkedIdLookup(links: Iterable<readonly string[]>): (id: string) => Iterable<string> {
  const edges = new Map<string, Set<string>>()
  const connect = (a: string, b: string) => {
    if (!edges.has(a)) edges.set(a, new Set())
    edges.get(a)!.add(b)
  }
  for (const ids of links) {
    for (const id of ids.slice(1)) { connect(ids[0]!, id); connect(id, ids[0]!) }
  }
  return id => edges.get(id) ?? []
}

// An App finding can name the source findings it revalidated only by ID, in
// another row or report. The reader counts those as represented by it, so they
// are one issue for security too: hiding one side alone would leave the App
// answer to a hidden security finding, or a source row without its App row.
export function revalidationLinks(findings: Iterable<Finding>): string[][] {
  const links: string[][] = []
  for (const finding of findings) {
    const inputs = finding['revalidateInputs']
    if (typeof finding['id'] !== 'string' || !Array.isArray(inputs)) continue
    links.push([finding['id'], ...inputs.filter((id): id is string => typeof id === 'string' && id !== '')])
  }
  return links
}

// Parsed projections keep run inheritance and derived flags out of cached
// reports. A known positive security stamp may include linked findings outside
// this report; a negative stamp never overrides the intrinsic classifier.
export function projectFinding(value: unknown, report: Finding): Finding | null {
  const original = object(value)
  if (!original) return null
  const finding = { ...original }
  inheritReportMeta(finding, report)
  finding['_source'] = finding['source'] ?? report['source'] ?? null
  if (!('isApp' in finding)) finding['isApp'] = isAppFinding(finding, finding['_source'])
  if (finding['isSecurity'] === true) finding['security'] = true
  return finding
}

// Native JSON and supported text imports obey the same permission rules.
// A filtered text import is returned as JSON under its original filename, which
// readManagedReport already accepts. Unchanged inputs keep their original bytes.
export function filterReportContent(content: string, perms: ViewerPermissions, filename = '', repo?: unknown): string {
  if (perms.dependencies && perms.security) return content
  let data: unknown
  try { data = JSON.parse(content) } catch {
    const parsed = readManagedReport(content, filename)
    if (parsed.data == null) {
      if (/\.csv$/iu.test(filename)) throw new Error('Cannot filter unreadable CSV report')
      return content
    }
    data = parsed.data
  }
  const filtered = filterReportData(data, perms, repo)
  return filtered === data ? content : JSON.stringify(filtered)
}

// repo, when supplied, is the server's authoritative assignment (including an
// explicit unassigned value). Finding-specific repos still describe their source.
export function filterReportData(data: unknown, perms: ViewerPermissions, repo?: unknown, securityIds?: Set<string>): unknown {
  if (perms.dependencies && perms.security) return data
  const report = object(data)
  if (!report) return data
  const key = Array.isArray(report['findings']) ? 'findings' : Array.isArray(report['groups']) ? 'groups' : null
  if (!key) return data
  const entries = (report[key] as unknown[]).map(entry => ({
    entry, members: (Array.isArray(entry) ? entry : [entry]).map(original => ({ original, finding: projectFinding(original, report) })),
  }))
  const groups = entries.map(({ members }) => members.flatMap(({ finding }) => finding ? [finding] : []))
  if (!perms.security) stampSecurityGroups(groups, { linkedIds: linkedIdLookup(revalidationLinks(groups.flat())) })
  const githubOrgs = new Set<string>(), npmScopes = new Set<string>()
  const addOrgs = (finding: Finding) => {
    const github = githubOrg(finding), npm = npmScope(finding)
    if (github) githubOrgs.add(github)
    if (npm) npmScopes.add(npm)
  }
  addOrgs({ ...report, repo: repo === undefined ? report['repo'] : repo })
  for (const finding of groups.flat()) {
    if (finding['isApp'] !== true && !isDependency(finding)) addOrgs(finding)
  }
  const kept: unknown[] = []
  let changed = false
  for (const { entry, members } of entries) {
    // Classify the complete row before hiding dependency components.
    if (!perms.security && members.some(({ finding }) => finding?.['isSecurity'] === true || securityIds?.has(String(finding?.['id'])))) { changed = true; continue }
    const visible = members.filter(({ finding }) => !finding || perms.dependencies || finding['isApp'] === true || !isDependency(finding)
      || githubOrgs.has(githubOrg(finding) ?? '') || npmScopes.has(npmScope(finding, true) ?? ''))
    if (visible.length === members.length) kept.push(entry)
    else {
      changed = true
      if (visible.length > 0) kept.push(Array.isArray(entry) ? visible.map(({ original }) => original) : visible[0]!.original)
    }
  }
  return changed ? { ...report, [key]: kept } : data
}
