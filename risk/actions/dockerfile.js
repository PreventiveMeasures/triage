// A Docker action's Dockerfile, which GitHub builds as a workflow runs:
// each `FROM` by a tag (`unpinned-image`), not a stage of its own or
// `scratch`, and one a build argument names yellow, as it may be pinned
// where it is set; and each `RUN`'s commands, read as a script's
// (scripts/grade.js), its lines each the file's. Each finding's `line`
// counts from 1.
import { readImage } from './uses.js'
import { imageFinding, scriptFindings } from './scripts/grade.js'

// An instruction's lines, its continuations (`\` at a line's end) joined.
function instructions(text) {
  const lines = text.split('\n').map(line => line.replace(/\r$/u, ''))
  const found = []
  for (let at = 0; at < lines.length; at++) {
    const start = at
    while (lines[at].endsWith('\\') && at + 1 < lines.length) at++
    found.push({ start, lines: lines.slice(start, at + 1) })
  }
  return found
}

// A `RUN`'s command, its exec form (`RUN ["sh", "-c", "…"]`) as the words it
// runs.
function runCommand(text) {
  if (!text.trimStart().startsWith('[')) return text
  try {
    const words = JSON.parse(text)
    return Array.isArray(words) ? words.map(word => /[\s'"]/u.test(String(word)) ? `'${String(word).replaceAll("'", "'\\''")}'` : String(word)).join(' ') : text
  } catch { return text }
}

// Every finding of a Dockerfile's text.
export function dockerfileFindings(text) {
  const findings = [], script = [], stages = new Set()
  for (const { start, lines } of instructions(text)) {
    const first = /^\s*(FROM|RUN)\s+(.*)$/iu.exec(lines[0])
    if (first?.[1].toUpperCase() === 'RUN') { script.push(runCommand(first[2]), ...lines.slice(1)); continue }
    script.push(...lines.map(() => ''))
    if (!first) continue
    const words = lines.join(' ').replaceAll('\\', ' ').trim().split(/\s+/u).slice(1).filter(word => !word.startsWith('--'))
    const [image, as, stage] = words
    const built = image && stages.has(image.toLowerCase())
    if (as?.toLowerCase() === 'as' && stage) stages.add(stage.toLowerCase())
    if (!image || image === 'scratch' || built) continue
    const read = readImage(image)
    if (image.includes('$')) findings.push({ id: 'unpinned-image', severity: 'moderate', image, via: 'from', line: start + 1 })
    else if (!read?.digest) findings.push({ ...imageFinding(image, read, 'from'), line: start + 1 })
  }
  const run = { script: script.join('\n'), line: 1, start: 1 }
  findings.push(...scriptFindings(run, { locked: () => false, installed: false, external: true, triggers: [] }))
  return findings.toSorted((a, b) => a.line - b.line)
}
