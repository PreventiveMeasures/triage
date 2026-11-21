// What calls for a look at an npm version, as the managed server's risk tells
// it (GET /api/npm/risk, server-managed/npm-risk.ts), shown in the Overview and Compare.
import { fetchNpmRisk } from './client-managed.js'
import { npmPackageData } from './npm-package.js'
import { npmRiskOf } from './file-risk.js'

// What the server tells of version `npm` (`{ name, version }`), against
// `otherVersion` where given: `{ findings, files, dependencies }`, null until
// it arrives or where it can't be had. `signal` gives up the request where
// this is the first to ask, as the server makes only a few at once.
export function npmRisk(npm, otherVersion = null, signal = undefined) {
  const data = npmPackageData('risk', `${npm.name}@${npm.version}${otherVersion === null ? '' : `..${otherVersion}`}`,
    () => fetchNpmRisk(npm.name, npm.version, otherVersion, { signal }), npmRiskOf)
  return data.status === 'ready' ? data : null
}
