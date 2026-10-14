// What calls for a look at an npm version, as the managed server's risk tells
// it (GET /api/npm/risk, server-managed/npm-risk.ts): the viewer tells none
// of it itself, but shows it, in the Overview and Compare, a version's
// details carrying its own (npm-package.js npmPackageDetails, file-risk.js).
import { fetchNpmRisk } from './client-managed.js'
import { npmPackageData } from './npm-package.js'
import { npmRiskOf } from './file-risk.js'

// What the server tells of the version `npm` names (`{ name, version }`),
// against `otherVersion` where given: `{ findings, files, dependencies }`,
// its files' readings by path. Null until it arrives, and where it can't be
// had. `signal` gives up the request where this is the first to ask for it
// (npmPackageData), as the server makes only a few at once.
export function npmRisk(npm, otherVersion = null, signal = undefined) {
  const data = npmPackageData('risk', `${npm.name}@${npm.version}${otherVersion === null ? '' : `..${otherVersion}`}`,
    () => fetchNpmRisk(npm.name, npm.version, otherVersion, { signal }), npmRiskOf)
  return data.status === 'ready' ? data : null
}
