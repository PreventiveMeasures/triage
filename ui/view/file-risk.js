// What was read of the files of a version or bundle, for their tags: an npm
// version's as the managed server's risk tells it (npmRiskOf), which its
// details carry (`risk`, npm-package.js npmPackageDetails, npm-risk.js
// npmRisk), the viewer reading none; a Stasis bundle's read here
// (risk/npm/files.js), as no server tells them.
import { npmVersionFileRisk } from '../../risk/npm/files.js'

// A record as the Map risk keeps it as, its keys read by `key`; null for none.
const mapOf = (record, key = name => name) => record ? new Map(Object.entries(record).map(([name, value]) => [key(name), value])) : null

// What risk read of a file (risk/files/stamps.js npmFileRisk) as the viewer
// reads it: what it runs, the services and hosts it names, and its
// characters, by code point, as Maps, as JSON keeps none.
const fileOf = ({ stamps, readability, runsCode, exfiltration, hosts }) => ({
  stamps, runsCode: mapOf(runsCode), exfiltration: mapOf(exfiltration), hosts: mapOf(hosts),
  readability: readability && { ...readability, controls: mapOf(readability.controls, Number) },
})

// A finding as the viewer's chips read it: what a file holds, and what of it
// is new (`added`), as Maps, and a tier past the last as Infinity, as JSON
// keeps none of them.
function findingOf(finding) {
  switch (finding.id) {
    case 'held-runs-code': case 'held-exfiltration': case 'held-remote': case 'held-ip-lookup':
      return { ...finding, files: finding.files.map(row => ({ ...row, found: mapOf(row.found), ...row.added ? { added: mapOf(row.added) } : {} })) }
    case 'popularity': return { ...finding, tier: finding.tier ?? Infinity }
    default: return finding
  }
}

// What the server's risk tells (its answer, server-managed/npm-risk.ts) as
// the viewer reads it: `{ oldVersion, findings, files, dependencies }`, the
// version it was compared with (null for none), and its files' readings by
// path.
export const npmRiskOf = answer => ({
  oldVersion: answer.oldVersion ?? null,
  findings: answer.findings.map(findingOf),
  files: new Map(Object.entries(answer.files).map(([path, file]) => [path, fileOf(file)])),
  dependencies: answer.dependencies,
  score: answer.score ?? null,
})

// An npm version's files' readings, by path, as its risk tells them (`details`
// its details); null until it arrives, and for a Stasis bundle's.
export const npmFilesRisk = details => details?.npm ? details.risk?.()?.files ?? null : null

// What was read of a file (`path`) of a version or bundle (`details`)
// (risk/files/stamps.js npmFileRisk): an npm version's as its risk tells it,
// nothing read until it arrives; a Stasis bundle's read here, once a bundle.
const UNREAD = { stamps: [], readability: null, runsCode: null, exfiltration: null, hosts: null }
export function fileRiskOf(details, path) {
  if (!details?.npm) return npmVersionFileRisk(details, path)
  return npmFilesRisk(details)?.get(path) ?? UNREAD
}
