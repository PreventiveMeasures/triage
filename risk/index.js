// What calls for a look at a package version, or a repository's GitHub
// Actions, for a reviewer: risk's heuristics, apart from any view of them.
// See README.md.
export { assessNpm } from './npm/assess.js'
export { npmMalwareAdvisory } from './npm/malware.js'
export { DEFAULT_MINIMUM_RELEASE_AGE } from './npm/release.js'
export { NpmRiskError, npmReadyDownload, npmReadyDownloads } from './npm/registry.js'
export { SEVERITIES, npmFileRisk } from './files/stamps.js'
export { readWorkflow } from './actions/workflow.js'
export { actionInstalls, scanWorkflow, workflowUses } from './actions/findings.js'
export { dockerfileFindings, keptSource, resolveAction } from './actions/resolve.js'
export { usesOfKey } from './actions/uses.js'
