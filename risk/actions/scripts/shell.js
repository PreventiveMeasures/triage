// A `run:` script read into the commands it runs, as a shell would split
// them, for commands.js: its lines continued joined, comments set aside,
// each line split at `&&`, `||`, `;`, `&` and `|`, each command's words
// unquoted, past settings and wrappers (`NAME=value`, `sudo -E`, `env`), a
// command substitution and a shell's command line (`sh -c '…'`) read as a
// line of its own. A quick read, not a
// shell's parse: a command built as the script runs goes unseen.

// A line of a script, its continuations joined, and the line it starts on,
// counting from 0.
export function scriptLines(script) {
  const lines = script.split('\n')
  const joined = []
  for (let at = 0; at < lines.length; at++) {
    const start = at
    let text = lines[at].replace(/\r$/u, '')
    while (/(?:^|[^\\])(?:\\\\)*[\\`^]$/u.test(text) && at + 1 < lines.length) text = `${text.slice(0, -1)} ${lines[++at].replace(/\r$/u, '')}`
    joined.push({ text, line: start })
  }
  return joined
}

const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'nice', 'stdbuf', 'xvfb-run', 'timeout'])
// A wrapper's options taking a value, as `sudo -u user`, `timeout 10m` do.
const WRAPPER_VALUES = new Map([['sudo', /^-[ugCDhpRrTU]$/u], ['env', /^-[uSC]$/u], ['nice', /^-n$/u], ['timeout', /^-[sk]$/u]])

// What a command runs: its words past settings and wrappers, a wrapper's
// options and their values, and `timeout`'s duration.
function argvOf(words) {
  let at = 0
  for (;;) {
    while (at < words.length && /^[A-Za-z_]\w*=/u.test(words[at])) at++
    const wrapper = words[at]
    if (!WRAPPERS.has(wrapper)) return words.slice(at)
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

// A line's commands, each `{ argv, piped, out }`, `piped` where a pipe feeds
// it and `out` the file it writes its output to, and each command
// substitution's text (`nested`), to read as lines of their own.
function commandsOf(text) {
  const commands = [], nested = []
  let piped = false, quote = null, start = 0
  const end = (at, next) => {
    const { words, out } = wordsOf(text.slice(start, at))
    const argv = argvOf(words)
    if (argv.length > 0) commands.push({ argv, piped, out })
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

// The command line a shell is given to run (`bash -euc '…'`), else null.
function shellLine([program, ...words]) {
  if (!/^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k)?sh$/u.test(program)) return null
  const at = words.findIndex(word => /^-[a-z]*c[a-z]*$/u.test(word))
  return at === -1 ? null : words[at + 1] ?? null
}

// Each command of a script: `{ argv, piped, line, order, next }`, `line` the
// one it is on, counting from 0, `order` its place among them all, as they
// run, and `next` the command a pipe feeds it to, as a script fetched is fed
// to a shell; a shell's command line's after the shell, and a command
// substitution's after its line's. 64 lines read of each.
export function scriptCommands(script) {
  const found = []
  let read = 0
  const readLine = (text, line) => {
    if (read++ >= 64) return
    const { commands, nested } = commandsOf(text)
    commands.forEach((command, at) => {
      found.push({ ...command, line, order: found.length, next: commands[at + 1]?.piped ? commands[at + 1] : null })
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
