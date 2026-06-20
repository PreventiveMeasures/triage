// Server-side report filtering by a viewer's visibility permissions, applied
// before a team report's bytes are served (see server-managed/http.ts). A report
// is the analyzer's native JSON dump — `{ findings: [...] }` where each entry is
// a single finding object OR an array of finding objects (a dedup "duplicates"
// group; the client's toGroup() normalises both to an array of tabs).
//
// A viewer who lacks a permission has the matching findings stripped:
//   - dependencies off → drop findings classified as dependencies, i.e. whose
//     file sits under the report's deps dir (node_modules / vendor /
//     dependencies, picked by the same precedence the client's configureDepsDir
//     uses, scanned over THIS report).
//   - security off → drop findings where the finding — OR any entry in its
//     duplicates group — is from a security analyzer (an analyzer / type / source
//     string containing "security") or is stamped `security: true`.
//
// Non-JSON reports (markdown / CSV) aren't structurally filterable and pass
// through unchanged. Filtering is purely subtractive: kept entries keep their
// exact original shape (single object or array).

export interface ViewerPermissions {
  dependencies: boolean
  security: boolean
}

// Whole-segment matcher `(^|/)<dir>/` — `dir` must be a full path segment, so
// `node_modules/` matches `a/node_modules/x` but not `my-node_modules-x`.
function segRe(dir: string): RegExp {
  return new RegExp(`(^|/)${dir}/`, 'u')
}

const NODE_MODULES_RE = segRe('node_modules')
const VENDOR_RE = segRe('vendor')
const DEPENDENCIES_RE = segRe('dependencies')

// A findings-array entry → its tabs (a lone finding is a one-tab group).
function tabsOf(entry: unknown): unknown[] {
  return Array.isArray(entry) ? entry : [entry]
}

function fileOf(tab: unknown): string {
  const f = (tab as { file?: unknown } | null)?.file
  return typeof f === 'string' ? f : ''
}

// The report's deps dir matcher, mirroring the client's precedence
// (node_modules > vendor > dependencies) over this report's finding files.
function depsDirRe(groups: unknown[][]): RegExp {
  let hasVendor = false
  for (const g of groups) {
    for (const tab of g) {
      const file = fileOf(tab)
      if (NODE_MODULES_RE.test(file)) return NODE_MODULES_RE
      if (VENDOR_RE.test(file)) hasVendor = true
    }
  }
  return hasVendor ? VENDOR_RE : DEPENDENCIES_RE
}

function hasSecurityWord(x: unknown): boolean {
  return typeof x === 'string' && x.toLowerCase().includes('security')
}

// A tab is "security" if stamped `security: true`, or any analyzer-identifying
// string (the tab's analyzer / type / source, or the report-level source) names
// a security analyzer.
function tabIsSecurity(tab: unknown, reportSource: unknown): boolean {
  if (tab == null || typeof tab !== 'object') return false
  const t = tab as { security?: unknown; analyzer?: unknown; type?: unknown; source?: unknown }
  if (t.security === true) return true
  return hasSecurityWord(t.analyzer) || hasSecurityWord(t.type) || hasSecurityWord(t.source) || hasSecurityWord(reportSource)
}

// Filter `content` for a viewer with `perms`. Returns the (possibly rewritten)
// content string; the original is returned untouched when nothing is stripped or
// the content isn't a JSON findings dump.
export function filterReportContent(content: string, perms: ViewerPermissions): string {
  if (perms.dependencies && perms.security) return content // sees everything → no work
  let data: unknown
  try { data = JSON.parse(content) } catch { return content } // not JSON → pass through
  if (data == null || typeof data !== 'object') return content
  const findings = (data as { findings?: unknown }).findings
  if (!Array.isArray(findings)) return content
  const reportSource = (data as { source?: unknown }).source
  // Pair each original entry with its tabs (so kept entries keep their exact
  // shape), and pick the deps-dir matcher from the full set of tabs.
  const entries = findings.map((entry) => ({ entry, tabs: tabsOf(entry) }))
  const moduleRe = depsDirRe(entries.map((e) => e.tabs))
  const kept: unknown[] = []
  for (const { entry, tabs } of entries) {
    if (!perms.dependencies && tabs.some((t) => moduleRe.test(fileOf(t)))) continue
    if (!perms.security && tabs.some((t) => tabIsSecurity(t, reportSource))) continue
    kept.push(entry)
  }
  if (kept.length === findings.length) return content // nothing stripped
  return JSON.stringify({ ...(data as object), findings: kept })
}
