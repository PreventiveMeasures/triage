// A workflow, or an action's metadata (action.yml), read for what it runs:
// the events it runs on, and each job's steps in order, each step's `uses`
// (uses.js) or `run` script, with the shell and the directory it runs in,
// and the images its jobs run in (`container:`, `services:`); an action's
// `runs`: a composite one's steps, a Docker one's image, a JavaScript one's
// runtime. Each with the line it is on, counting from 1, a script's own
// lines each the file's where it is a `|` block scalar.
import { YamlError, parseYaml } from './yaml.js'
import { readImage, readUses } from './uses.js'

// Why a workflow, an action or a reference couldn't be read or resolved, by
// its `code`, `message` telling more.
export class ActionsScanError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'ActionsScanError'
    this.code = code
  }
}

const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const stringOf = value => typeof value === 'string' ? value : null

// The line `key` of a mapping, or an entry of a sequence, is on, counting
// from 1, as GitHub's links to a line count; `fallback` where none is told.
function lineOf(file, container, key, fallback) {
  const at = container !== null && typeof container === 'object' ? file.positions.get(container) : undefined
  const line = at instanceof Map ? at.get(key) : at?.[key]
  return line === undefined ? fallback : line + 1
}

// The comment a line ends with, as a `uses:` line's names a version.
function commentOn(line) {
  const m = /(?:^|[ \t])(#.*)$/u.exec(line ?? '')
  return m ? m[1] : null
}

// The events `on` names: a string, a list, or a mapping's keys.
function triggersOf(on) {
  if (typeof on === 'string') return [on]
  if (Array.isArray(on)) return on.filter(event => typeof event === 'string')
  return isMap(on) ? Object.keys(on) : []
}

// Where a value's text starts, where it is a `|` block scalar: on the line
// after its key's, each of its lines the file's in turn; else null.
const LITERAL_HEADER = /:[ \t]+(?:&\S+[ \t]+)?\|[1-9+-]{0,2}[ \t]*(?:#.*)?$/u
const literalStart = (file, line) => line !== null && LITERAL_HEADER.test(file.lines[line - 1] ?? '') ? line + 1 : null

// A `run:` step's script and where it runs: its shell and directory as the
// step says, else as its job's `defaults.run` or the workflow's say.
function runOf(file, step, defaults) {
  const script = stringOf(step.run)
  if (script === null) return null
  const line = lineOf(file, step, 'run', null)
  return { script, line, start: literalStart(file, line), shell: stringOf(step.shell) ?? defaults.shell,
    workingDirectory: stringOf(step['working-directory']) ?? defaults.workingDirectory }
}

function stepsOf(file, steps, defaults) {
  if (!Array.isArray(steps)) return []
  return steps.flatMap((step, index) => {
    if (!isMap(step)) return []
    const line = lineOf(file, steps, index, null)
    const usesLine = lineOf(file, step, 'uses', line)
    const uses = typeof step.uses === 'string' ? { ...readUses(step.uses, { comment: commentOn(file.lines[usesLine - 1]) }), line: usesLine } : null
    const inputs = isMap(step.with) ? step.with : null
    const withLines = inputs ? Object.fromEntries(Object.keys(inputs).map(key => [key, lineOf(file, inputs, key, line)])) : {}
    return [{ line, uses, run: runOf(file, step, defaults), with: inputs, withLines, id: stringOf(step.id) }]
  })
}

// `defaults.run` of a workflow or a job, over `outer`'s.
function defaultsOf(owner, outer) {
  const run = isMap(owner?.defaults) && isMap(owner.defaults.run) ? owner.defaults.run : {}
  return { shell: stringOf(run.shell) ?? outer.shell, workingDirectory: stringOf(run['working-directory']) ?? outer.workingDirectory }
}

// The images a job runs in, each as written (`text`), read (readImage) and
// where: its container, and each of its services'.
function imagesOf(file, job) {
  const images = []
  const container = isMap(job.container) ? job.container.image : job.container
  if (typeof container === 'string') images.push({ via: 'container', text: container, line: lineOf(file, isMap(job.container) ? job.container : job, isMap(job.container) ? 'image' : 'container', null) })
  if (isMap(job.services)) {
    for (const [name, service] of Object.entries(job.services)) {
      if (isMap(service) && typeof service.image === 'string') images.push({ via: 'services', service: name, text: service.image, line: lineOf(file, service, 'image', null) })
    }
  }
  return images.map(image => ({ ...image, read: readImage(image.text) }))
}

function jobsOf(file, doc) {
  if (!isMap(doc.jobs)) throw new ActionsScanError('workflow-unreadable', 'a workflow has no jobs')
  const defaults = defaultsOf(doc, { shell: null, workingDirectory: null })
  return Object.entries(doc.jobs).filter(([, job]) => isMap(job)).map(([id, job]) => {
    const usesLine = lineOf(file, job, 'uses', null)
    const uses = typeof job.uses === 'string' ? { ...readUses(job.uses, { job: true, comment: commentOn(file.lines[usesLine - 1]) }), line: usesLine } : null
    return { id, line: lineOf(file, doc.jobs, id, null), uses, with: isMap(job.with) ? job.with : null, secrets: job.secrets ?? null,
      steps: stepsOf(file, job.steps, defaultsOf(job, defaults)), images: imagesOf(file, job) }
  })
}

// An action's `runs`: its runtime (`using`), a composite one's steps as a
// job of its own, and a Docker one's image (`docker://…`) or the file it is
// built from (`Dockerfile`, beside action.yml).
function runsOf(file, doc) {
  const runs = isMap(doc.runs) ? doc.runs : null
  if (!runs || typeof runs.using !== 'string') throw new ActionsScanError('workflow-unreadable', 'an action has no runs.using')
  const using = runs.using.toLowerCase()
  const usingLine = lineOf(file, runs, 'using', null)
  const image = using === 'docker' ? stringOf(runs.image) : null
  const imageLine = lineOf(file, runs, 'image', usingLine)
  const docker = image?.startsWith('docker://') ? { via: 'runs', text: image.slice('docker://'.length), line: imageLine, read: readImage(image.slice('docker://'.length)) } : null
  const steps = using === 'composite' ? stepsOf(file, runs.steps, { shell: null, workingDirectory: null }) : []
  return { using, usingLine, dockerfile: image && !docker ? { path: image, line: imageLine } : null,
    jobs: [{ id: null, line: usingLine, uses: null, steps, images: docker ? [docker] : [] }] }
}

// A workflow (`kind` 'workflow') or an action's metadata ('action') read
// from its text. Throws an ActionsScanError (`workflow-unreadable`) for one
// that isn't YAML, or isn't shaped as GitHub runs one, its YAML's line in
// the message.
export function readWorkflow(kind, text) {
  const file = { lines: text.split('\n'), positions: new WeakMap() }
  let doc
  try { doc = parseYaml(text, { workflow: true, lines: file.positions }) } catch (error) {
    if (error instanceof YamlError) throw new ActionsScanError('workflow-unreadable', error.message)
    throw error
  }
  if (!isMap(doc)) throw new ActionsScanError('workflow-unreadable', `${kind === 'action' ? 'an action' : 'a workflow'} is not a mapping`)
  if (kind === 'action') return { kind, triggers: [], ...runsOf(file, doc) }
  return { kind, triggers: triggersOf(doc.on), using: null, usingLine: null, dockerfile: null, jobs: jobsOf(file, doc) }
}
