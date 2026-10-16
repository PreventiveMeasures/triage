// What calls for a look at a repository's GitHub Actions, for a reviewer:
// its workflows and the actions they use, read from their code, apart from
// any view of them. See README.md.
import { readWorkflow } from './workflow.js'
import { workflowFindings, workflowUses } from './findings.js'

export { ActionsScanError, readWorkflow } from './workflow.js'
export { workflowFindings, workflowUses } from './findings.js'
export { dockerfileFindings } from './dockerfile.js'
export { keptSource, resolveAction } from './resolve.js'
export { ownerKind, readUses, usesKey, usesOfKey } from './uses.js'

// A workflow's (`kind` 'workflow') or an action's metadata's ('action') text
// read for what it calls for by itself, and what it names to resolve: its
// findings, and its references (findings.js workflowUses), each with its
// line. Throws an ActionsScanError (`workflow-unreadable`) for one that
// isn't YAML, or isn't shaped as GitHub runs one.
export function scanWorkflow(kind, text, options = {}) {
  const read = readWorkflow(kind, text)
  return { triggers: read.triggers, using: read.using, uses: workflowUses(read), findings: workflowFindings(read, options) }
}
