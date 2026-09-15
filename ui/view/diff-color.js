// Recognises diff output and labels each line, so ui/terminal.js can
// paint it. A port of the terminal package's own REPL colorizer
// (`bin/diff-color.js` in PreventiveMeasures/terminal): the library
// returns plain text and each front end paints it, so the rules are
// shared but the output is not — the REPL writes ANSI through
// styleText, this hands back line kinds for the shadow-DOM stylesheet.
//
// The format is recognised from its own structural markers rather than
// from the command that ran, because a `RunResult` carries no argv to
// look at, and because `cat` of a patch file deserves the same
// treatment as `diff`. Each marker is one a real diff emits and
// ordinary text does not, so a source file full of `+` bullets or
// `---` rules stays plain.

const UNIFIED_HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u
const CONTEXT_FENCE = /^\*{15}$/u
const NORMAL_COMMAND = /^\d+(?:,\d+)?[acd]\d+(?:,\d+)?$/u

// Longest prefix first, so `---` is read as a file header rather than a
// removed line, and `+++` before `+`.
const UNIFIED = [
  [/^--- /u, 'head'], [/^\+\+\+ /u, 'head'], [UNIFIED_HUNK, 'hunk'],
  [/^\+/u, 'add'], [/^-/u, 'del'], [/^\\ /u, 'meta'],
]
const CONTEXT = [
  [CONTEXT_FENCE, 'hunk'], [/^\*{3} \d/u, 'hunk'], [/^--- \d/u, 'hunk'],
  [/^\*{3} /u, 'head'], [/^--- /u, 'head'],
  [/^! /u, 'chg'], [/^\+ /u, 'add'], [/^- /u, 'del'],
]
const NORMAL = [
  [NORMAL_COMMAND, 'hunk'], [/^< /u, 'del'], [/^> /u, 'add'], [/^---$/u, 'meta'],
]

function rulesFor(lines) {
  // Context diffs also carry `---` headers, so the fence is checked first.
  if (lines.some((line) => CONTEXT_FENCE.test(line))) return CONTEXT
  if (lines.some((line) => UNIFIED_HUNK.test(line))) return UNIFIED
  if (lines.some((line) => NORMAL_COMMAND.test(line))) return NORMAL
  return null
}

// `null` for anything that isn't a diff — the caller keeps rendering it
// as the single text node it already was, so nothing changes for the
// ordinary case. Otherwise one entry per line, `kind` empty for lines no
// rule claims: a unified diff is mostly context lines, and leaving those
// unwrapped keeps a large diff from becoming a span per line.
export function classifyDiff(text) {
  if (text === '') return null
  const lines = text.split('\n')
  const rules = rulesFor(lines)
  if (!rules) return null
  return lines.map((line) => ({
    text: line,
    kind: rules.find(([pattern]) => pattern.test(line))?.[1] ?? '',
  }))
}
