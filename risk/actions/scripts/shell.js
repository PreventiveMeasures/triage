// A `run:` script read into the commands it runs, as a shell would split
// them, for commands.js. A quick read, not a shell's parse: a command built
// as the script runs goes unseen.
import { SHELLS } from '../../files/runs-code.js'
import { resolved } from '../../npm/files.js'

// A shell, by its program, wherever it is, Windows' `.exe` too (risk's
// runs-code.js SHELLS).
const SHELL = new RegExp(String.raw`^(?:.*[\/\\])?${SHELLS}(?:\.exe)?$`, 'iu')

// A line of a script, its continuations joined (an escaped line's end, or a
// pipe, `&&` or `||` the next line goes on from), and the line it starts
// on, counting from 0.
export function scriptLines(script) {
  const lines = script.split('\n')
  const joined = []
  for (let at = 0; at < lines.length; at++) {
    const start = at
    let text = lines[at].replace(/\r$/u, '')
    for (;;) {
      const escaped = /(?:^|[^\\])(?:\\\\)*[\\`^]$/u.test(text), piped = /(?:\||&&)\s*$/u.test(text) && !/(?:^|\s)#/u.test(text)
      if (!(escaped || piped) || at + 1 === lines.length) break
      text = `${escaped ? text.slice(0, -1) : text} ${lines[++at].replace(/\r$/u, '')}`
    }
    joined.push({ text, line: start })
  }
  return joined
}

const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'nice', 'stdbuf', 'xvfb-run', 'timeout'])
// A wrapper's options taking a value, as `sudo -u user`, `timeout 10m` do.
const WRAPPER_VALUES = new Map([['sudo', /^-[ugCDhpRrTU]$/u], ['env', /^-[uSC]$/u], ['nice', /^-n$/u], ['timeout', /^-[sk]$/u]])

// What a command runs (`argv`): its words past settings, kept (`env`), and
// wrappers, a wrapper's options and their values, and `timeout`'s duration.
function argvOf(words) {
  const env = {}
  let at = 0
  for (;;) {
    for (; at < words.length && /^[A-Za-z_]\w*=/u.test(words[at]); at++) env[words[at].slice(0, words[at].indexOf('='))] = words[at].slice(words[at].indexOf('=') + 1)
    const wrapper = words[at]?.replace(/^.*\//u, '')
    if (!WRAPPERS.has(wrapper)) return { argv: words.slice(at), env }
    at++
    while (at < words.length && words[at].startsWith('-')) at += WRAPPER_VALUES.get(wrapper)?.test(words[at]) ? 2 : 1
    if (wrapper === 'timeout' && /^\d/u.test(words[at] ?? '')) at++
  }
}

// A command's words, quotes taken off, redirections dropped, and the file
// its output is written to (`> file`, `>> file`), or null.
function wordsOf(text) {
  const words = []
  let quote = null, word = null
  for (let at = 0; at <= text.length; at++) {
    const char = text[at]
    if (quote) {
      if (char === quote) quote = null
      else if (char === undefined) break
      else word += quote === '"' && char === '\\' && /["\\$`]/u.test(text[at + 1] ?? '') ? text[++at] : char
    } else if (char === undefined || /\s/u.test(char)) {
      if (word !== null) words.push(word)
      word = null
    } else if (char === '"' || char === "'") { quote = char; word ??= '' }
    // A redirection joined to a word before it (`url>file`) starts its own.
    else if ((char === '>' || char === '<') && word !== null && !/^\d*&?$|[<>]$/u.test(word)) { words.push(word); word = char }
    else word = (word ?? '') + (char === '\\' && at + 1 < text.length ? text[++at] : char)
  }
  const kept = []
  let out = null
  for (let at = 0; at < words.length; at++) {
    const redirect = /^(\d*)(>>?|<<?|&>>?)(.*)$/u.exec(words[at])
    if (!redirect) { kept.push(words[at]); continue }
    const target = redirect[3] === '' ? words[++at] : redirect[3]
    if (redirect[2].includes('>') && (redirect[1] === '' || redirect[1] === '1') && target && !target.startsWith('&')) out = target
  }
  return { words: kept, out }
}

// Where a `$(…)` starting at `from` (its `(`) closes, or the line's end.
function closing(text, from) {
  let depth = 0, quote = null
  for (let at = from; at < text.length; at++) {
    const char = text[at]
    if (quote) { if (char === quote) quote = null; else if (char === '\\') at++ }
    else if (char === "'" || char === '"') quote = char
    else if (char === '(') depth++
    else if (char === ')' && --depth === 0) return at
  }
  return text.length
}

// A line's commands, each `{ argv, env, piped, out, nested }`, `env` the
// settings it runs with, `piped` where a pipe feeds it, `out` the file it writes its output to and `nested` its
// command substitutions' text, to read as lines of their own; and those of
// none of them (`nested`).
function commandsOf(text) {
  const commands = []
  let nested = [], piped = false, quote = null, start = 0
  const end = (at, next) => {
    const { words, out } = wordsOf(text.slice(start, at))
    const { argv, env } = argvOf(words)
    if (argv.length > 0) { commands.push({ argv, env, piped, out, nested }); nested = [] }
    piped = next
  }
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if (quote === "'") { if (char === "'") quote = null; continue }
    if (char === '\\') { at++; continue }
    if (char === '$' && text[at + 1] === '(') {
      const close = closing(text, at + 1)
      nested.push(text.slice(at + 2, close))
      at = close
    } else if (quote === '"') { if (char === '"') quote = null }
    else if (char === '"' || char === "'") quote = char
    else if (char === '#' && (at === 0 || /\s/u.test(text[at - 1]))) { end(at, false); start = text.length; break }
    else if ((char === '&' || char === '|') && text[at + 1] === char) { end(at, false); start = ++at + 1 }
    else if (char === ';' || (char === '&' && !/[<>]/u.test(text[at - 1] ?? '') && text[at + 1] !== '>')) { end(at, false); start = at + 1 }
    else if (char === '|') { end(at, true); start = at + (text[at + 1] === '&' ? 2 : 1); if (text[at + 1] === '&') at++ }
  }
  if (start < text.length) end(text.length, false)
  return { commands, nested }
}

// The command line a shell is given to run (`bash -euc '…'`, `pwsh
// -Command '…'`), else null.
function shellLine([program, ...words]) {
  if (!SHELL.test(program)) return null
  const option = /(?:pwsh|powershell)(?:\.exe)?$/iu.test(program) ? /^-(?:c|command)$/iu : /^-[a-z]*c[a-z]*$/u
  const at = words.findIndex(word => option.test(word))
  return at === -1 ? null : words[at + 1] ?? null
}

// A path `to` from `dir`, both from the step's directory ('' for it); as
// written where a variable, `~`, `-` or an absolute path names it.
export const pathFrom = (dir, to) => /^[$~/-]/u.test(to) ? to : resolved(dir ? dir.split('/') : [], to)?.join('/') ?? [dir, to].filter(Boolean).join('/')

// Each command of a script, in the order they run (`order`): its `line` from
// 0, the directory the `cd`s before it moved to (`dir`, by pathFrom), and
// `next`, the command a pipe feeds it to; a command substitution's before
// its command's, a shell's command line's (`sh -c`) after it.
export function scriptCommands(script) {
  const found = []
  let dir = '', read = 0
  const readLine = (text, line) => {
    if (read++ >= 64) return
    const { commands, nested } = commandsOf(text)
    commands.forEach(({ nested: substituted, ...command }, at) => {
      for (const each of substituted) readLine(each, line)
      found.push({ ...command, line, dir, order: found.length, next: commands[at + 1]?.piped ? commands[at + 1] : null })
      if (command.argv[0] === 'cd') dir = pathFrom(dir, command.argv.slice(1).find(word => !/^-[LPe@]+$/u.test(word)) ?? '~')
      const shell = shellLine(command.argv)
      if (shell) readLine(shell, line)
    })
    for (const each of nested) readLine(each, line)
  }
  for (const { text, line } of scriptLines(script)) {
    read = 0
    readLine(text, line)
  }
  return found
}
