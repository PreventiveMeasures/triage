// A workflow, or an action's metadata, read for what it runs: its events, its
// jobs' steps (`uses`, `run`) and images, each on its line from 1.
import { YamlError, parseYaml } from '@preventive/lockfile/yaml.js'
import { readImage, readUses } from './uses.js'

const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const stringOf = value => typeof value === 'string' ? value : null

// The line, from 1, `key` of a mapping or an entry of a sequence is on.
function lineOf(file, container, key, fallback) {
  const at = container !== null && typeof container === 'object' ? file.positions.get(container) : undefined
  const line = at instanceof Map ? at.get(key) : at?.[key]
  return line === undefined ? fallback : line + 1
}

// A step's or a job's `uses`, on its line, with the comment that line ends with.
function usesOf(file, owner, fallback, job = false) {
  if (typeof owner.uses !== 'string') return null
  const line = lineOf(file, owner, 'uses', fallback)
  return { ...readUses(owner.uses, { job, comment: /(?:^|[ \t])(#.*)$/u.exec(file.lines[line - 1] ?? '')?.[1] ?? null }), line }
}

function triggersOf(on) {
  if (typeof on === 'string') return [on]
  if (Array.isArray(on)) return on.filter(event => typeof event === 'string')
  return isMap(on) ? Object.keys(on) : []
}

// The line a `|` block scalar's text starts on, after its key's; else null.
const LITERAL_HEADER = /:[ \t]+(?:&\S+[ \t]+)?\|[1-9+-]{0,2}[ \t]*(?:#.*)?$/u
const literalStart = (file, line) => line !== null && LITERAL_HEADER.test(file.lines[line - 1] ?? '') ? line + 1 : null

// A `run:` step's script, and its directory, else `directory` (defaults.run);
// `production` where its `env`, else the job's or the workflow's (`env`),
// sets NODE_ENV so, as an install then leaves devDependencies out.
const envOf = (owner, outer = {}) => ({ ...outer, ...isMap(owner?.env) ? owner.env : {} })
function runOf(file, step, directory, env) {
  const script = stringOf(step.run)
  if (script === null) return null
  const line = lineOf(file, step, 'run', null)
  return { script, line, start: literalStart(file, line), workingDirectory: stringOf(step['working-directory']) ?? directory,
    production: envOf(step, env).NODE_ENV === 'production' }
}

// A step's or a job's `with`, and the line each input is on.
function inputsOf(file, owner, line) {
  const inputs = isMap(owner.with) ? owner.with : null
  return { with: inputs, withLines: inputs ? Object.fromEntries(Object.keys(inputs).map(key => [key, lineOf(file, inputs, key, line)])) : {} }
}

function stepsOf(file, steps, directory, env = {}) {
  if (!Array.isArray(steps)) return []
  return steps.flatMap((step, index) => {
    if (!isMap(step)) return []
    const line = lineOf(file, steps, index, null)
    return [{ line, uses: usesOf(file, step, line), run: runOf(file, step, directory, env), ...inputsOf(file, step, line) }]
  })
}

// The directory a workflow's or a job's `defaults.run` names, else `outer`.
const directoryOf = (owner, outer) => stringOf(isMap(owner?.defaults) && isMap(owner.defaults.run) ? owner.defaults.run['working-directory'] : null) ?? outer

// The images a job runs in: its container's and its services'.
function imagesOf(file, job) {
  const images = []
  const container = isMap(job.container) ? job.container.image : job.container
  if (typeof container === 'string') images.push({ text: container, line: lineOf(file, isMap(job.container) ? job.container : job, isMap(job.container) ? 'image' : 'container', null) })
  if (isMap(job.services)) {
    for (const service of Object.values(job.services)) {
      if (isMap(service) && typeof service.image === 'string') images.push({ text: service.image, line: lineOf(file, service, 'image', null) })
    }
  }
  return images.map(image => ({ ...image, read: readImage(image.text) }))
}

function jobsOf(file, doc) {
  if (!isMap(doc.jobs)) throw new YamlError('a workflow has no jobs')
  const directory = directoryOf(doc, null)
  return Object.values(doc.jobs).filter(isMap).map(job => ({ uses: usesOf(file, job, null, true), secrets: job.secrets ?? null, ...inputsOf(file, job, null),
    steps: stepsOf(file, job.steps, directoryOf(job, directory), envOf(job, envOf(doc))), images: imagesOf(file, job) }))
}

// An action's `runs`: its runtime, a composite one's steps as a job, and a
// Docker one's image or Dockerfile.
function runsOf(file, doc) {
  const runs = isMap(doc.runs) ? doc.runs : null
  if (!runs || typeof runs.using !== 'string') throw new YamlError('an action has no runs.using')
  const using = runs.using.toLowerCase()
  const usingLine = lineOf(file, runs, 'using', null)
  const image = using === 'docker' ? stringOf(runs.image) : null
  const imageLine = lineOf(file, runs, 'image', usingLine)
  const docker = image?.startsWith('docker://') ? { text: image.slice('docker://'.length), line: imageLine, read: readImage(image.slice('docker://'.length)) } : null
  const steps = using === 'composite' ? stepsOf(file, runs.steps, null) : []
  return { using, usingLine, dockerfile: image && !docker ? { path: image.replace(/^\.\//u, ''), line: imageLine } : null, jobs: [{ uses: null, steps, images: docker ? [docker] : [] }] }
}

// A workflow (`kind` 'workflow') or an action's metadata ('action') read, or
// the YamlError of one GitHub can't run.
export function readWorkflow(kind, text) {
  try {
    const file = { lines: text.split('\n'), positions: new WeakMap() }
    const doc = parseYaml(text, { workflow: true, lines: file.positions })
    if (!isMap(doc)) throw new YamlError(`${kind === 'action' ? 'an action' : 'a workflow'} is not a mapping`)
    if (kind === 'action') return { triggers: [], ...runsOf(file, doc) }
    return { triggers: triggersOf(doc.on), using: null, usingLine: null, dockerfile: null, jobs: jobsOf(file, doc) }
  } catch (error) {
    if (error instanceof YamlError) return error
    throw error
  }
}
