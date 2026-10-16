// What `workflow` reads beyond what pnpm writes (parse.js), as GitHub reads
// a workflow or an action's metadata: a plain or a quoted scalar over more
// than one line, folded as YAML folds it; a flow collection over more than
// one line; anchors and the aliases that name them. Each holds the line it
// starts on, and refuses a tab outside a block scalar's text, as parse.js
// does a line's.

import { YamlError, excerpt } from './error.js'

// The bounds a document's aliases are held to, as though each were a copy
// of what its anchor names: the nodes it comes to, and how deep.
export const MAX_EXPANDED = 2 ** 20
export const MAX_EXPANDED_DEPTH = 128

// A tab is read in a block scalar's text and a comment line alone: YAML
// refuses one that indents, and GitHub's workflows have them in scripts.
export function noTab(line) {
  if (line.text.includes('\t')) throw new YamlError('U+0009 is not allowed outside a block scalar', line.number)
}

// An anchor a node starts with, `&name` and the spaces after it, and what
// follows it.
export function readAnchor(text, line) {
  if (!text.startsWith('&')) return { anchor: null, rest: text }
  const m = /^&([^ ,[\]{}]+)(?: +|$)/u.exec(text)
  if (m === null) throw new YamlError(`expected an anchor's name, found ${excerpt(text)}`, line)
  return { anchor: m[1], rest: text.slice(m[0].length) }
}

// What an alias names: the very value its anchor's node is, not a copy, as
// js-yaml reads it.
export function readAlias(doc, text, line) {
  if (/^\*[^ ,[\]{}]+ *:(?: |$)/u.test(text)) throw new YamlError('an alias as a key is not supported', line)
  const m = /^\*([^ ,[\]{}]+)(?: +#.*| *)$/u.exec(text)
  if (m === null) throw new YamlError(`unexpected ${excerpt(text)} after an alias`, line)
  if (!doc.anchors.has(m[1])) throw new YamlError(`unknown alias ${excerpt(`*${m[1]}`)}`, line)
  doc.aliased = true
  return doc.anchors.get(m[1])
}

// Where a quote opening `text` at `from` closes on it, or -1: a `''` in a
// single-quoted scalar is one quote, a `\` in a double-quoted one escapes
// what follows.
export function closingQuote(text, from = 1) {
  const quote = text[0]
  for (let at = from; at < text.length; at++) {
    if (quote === '"' && text[at] === '\\') at++
    else if (text[at] === quote) {
      if (quote === "'" && text[at + 1] === "'") at++
      else return at
    }
  }
  return -1
}

// A double-quoted line's trailing spaces taken off, but one escaped
// (`\ `), and whether it ends with an escaped line break (a lone `\`).
function lineEnd(text, double) {
  const trailing = / *$/u.exec(text).index
  const escapes = /\\*$/u.exec(text.slice(0, trailing))[0].length
  if (double && escapes % 2 === 1) return trailing === text.length ? { text: text.slice(0, -1), escaped: true } : { text: text.slice(0, trailing + 1), escaped: false }
  return { text: text.slice(0, trailing), escaped: false }
}

// A quoted scalar's lines, its quotes off, folded as YAML folds them: the
// spaces around each break taken off, a break a space, an empty line a
// break, and an escaped break nothing.
function fold(lines, double) {
  let empties = 0, escaped = false, text = ''
  for (const [at, raw] of lines.entries()) {
    const last = at === lines.length - 1
    const trimmed = at === 0 ? raw : raw.replace(/^ +/u, '')
    if (at > 0 && !last && trimmed === '') { empties++; continue }
    if (at > 0) text += empties > 0 ? '\n'.repeat(empties) : escaped ? '' : ' '
    const end = last ? { text: trimmed, escaped: false } : lineEnd(trimmed, double)
    text += end.text
    empties = 0
    escaped = end.escaped
  }
  return text
}

// A quoted scalar that doesn't close on its owner's line (`first`), its
// lines read till it does: its text folded, unescaped by `unescape`, and
// nothing but a comment after it.
export function readQuotedLines(doc, first, owner, unescape) {
  const lines = [first.slice(1)]
  for (let line = doc.line; ; line = doc.advance()) {
    if (line === undefined || doc.isMarker(line)) throw new YamlError('a quoted scalar that does not close', owner.number)
    noTab(line)
    const end = closingQuote(`${first[0]}${line.text}`)
    if (end === -1) { lines.push(line.text); continue }
    lines.push(line.text.slice(0, end - 1))
    if (!/^(?: +#.*| *)$/u.test(line.text.slice(end))) throw new YamlError(`unexpected ${excerpt(line.text.slice(end))} after the value`, line.number)
    doc.advance()
    const text = fold(lines, first[0] === '"')
    return first[0] === '"' ? unescape(text, line.number) : text.replaceAll("''", "'")
  }
}

// A plain scalar's lines: `first`, its owner's, and those after it deeper
// than `indent` and not a comment, folded as YAML folds them, the spaces
// around each break taken off, a break a space and an empty line a break.
// A comment ends it, on its first line too.
export function readPlainLines(doc, first, indent) {
  if (/(?:^| )#/u.test(first)) return first
  let breaks = 0, text = first.replace(/ +$/u, '')
  for (let line = doc.line; line !== undefined; line = doc.advance()) {
    if (line.text === '') { breaks++; continue }
    if (line.indent <= indent || line.text.startsWith('#') || doc.isMarker(line)) break
    noTab(line)
    text += `${breaks > 0 ? '\n'.repeat(breaks) : ' '}${line.text.replace(/ +$/u, '')}`
    breaks = 0
    if (/ #/u.test(line.text)) { doc.advance(); break }
  }
  return text
}

// Where a flow collection's brackets stand after `text`, `open` of them open
// before it, and `last`, what the text before it ends in: how many are open
// (-1 where a quoted scalar doesn't close on its line), its text without a
// comment (`kept`), whether a comment ended it (`comment`), what its last
// token is (`last`: `plain` where it is a plain scalar's text, which a quote
// is part of too), and what follows where it closes (`after`).
function flowScan(text, open, last) {
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if (char === ' ') continue
    if ((char === '"' || char === "'") && last !== 'plain') {
      const end = closingQuote(text.slice(at))
      if (end === -1) return { open: -1, kept: text, last, comment: false }
      at += end
      last = 'quoted'
    } else if (char === '#' && (at === 0 || text[at - 1] === ' ')) return { open, kept: text.slice(0, at), last, comment: true }
    else if (char === '[' || char === '{') { open++; last = 'open' }
    else if (char === ']' || char === '}') {
      last = 'close'
      if (--open === 0) return { open, kept: text.slice(0, at + 1), after: text.slice(at + 1), last, comment: false }
    } else if (char === ',' || (char === ':' && /^(?:[ ,[\]{}]|$)/u.test(text[at + 1] ?? ''))) last = 'indicator'
    else last = 'plain'
  }
  return { open, kept: text, last, comment: false }
}

// A flow collection's text from its owner's line (`first`) to where it
// closes, its lines joined by a space, comments off; but a plain scalar's
// lines folded as YAML folds them, an empty line among them a break, and
// one a comment ended refused where it goes on, as js-yaml refuses it.
export function readFlowLines(doc, first, owner) {
  let breaks = 0, ended = false, plain = false, scan = flowScan(first, 0, null), text = ''
  for (let line = owner; ;) {
    if (scan.open === -1) throw new YamlError('a quoted scalar in a flow collection does not close on its line', line.number)
    const kept = scan.kept.replace(/ +$/u, '')
    if (kept !== '') {
      const goesOn = plain && !/^(?:[,\]}]|:(?:[ ,[\]{}]|$))/u.test(kept)
      if (goesOn && ended) throw new YamlError('a plain scalar in a flow collection goes on past a comment', line.number)
      if (text !== '') text += goesOn && breaks > 1 ? '\n'.repeat(breaks - 1) : ' '
      text += kept
      breaks = 0
      plain = scan.last === 'plain'
      ended = false
    }
    ended ||= plain && scan.comment
    if (scan.after !== undefined) {
      if (!/^(?: +#.*| *)$/u.test(scan.after)) throw new YamlError(`unexpected ${excerpt(scan.after)} after the value`, line.number)
      if (line !== owner) doc.advance()
      return text
    }
    line = line === owner ? doc.line : doc.advance()
    if (line === undefined || doc.isMarker(line)) throw new YamlError('a flow collection that does not close', owner.number)
    noTab(line)
    breaks++
    scan = flowScan(line.text, scan.open, plain && !ended ? 'plain' : null)
  }
}

// What a document comes to with each alias read as a copy of what its
// anchor names, as a caller walking it would: refused past MAX_EXPANDED
// nodes, or MAX_EXPANDED_DEPTH deep, twice as deep as one can be written,
// as a "billion laughs" of aliases is, though no copy is made. Each node is
// counted once, however many aliases name it, its size and height kept.
export function checkExpanded(value) {
  const known = new Map()
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object') return { size: 1, height: 0 }
    if (depth > MAX_EXPANDED_DEPTH) throw new YamlError(`aliases nest the document past ${MAX_EXPANDED_DEPTH} levels`)
    let seen = known.get(node)
    if (seen === undefined) {
      seen = { size: 1, height: 0 }
      for (const child of Object.values(node)) {
        const of = walk(child, depth + 1)
        seen.size += of.size
        seen.height = Math.max(seen.height, of.height + 1)
        if (seen.size > MAX_EXPANDED) throw new YamlError(`aliases expand the document past ${MAX_EXPANDED} nodes`)
      }
      known.set(node, seen)
    }
    if (depth + seen.height > MAX_EXPANDED_DEPTH) throw new YamlError(`aliases nest the document past ${MAX_EXPANDED_DEPTH} levels`)
    return seen
  }
  walk(value, 0)
}
