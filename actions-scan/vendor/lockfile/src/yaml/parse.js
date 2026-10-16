// The subset of YAML that pnpm writes lockfiles in, plus comments: block and
// flow mappings and sequences, plain and quoted scalars, `|` block scalars,
// and the `? key` form a key over 1024 characters needs. Anchors, aliases,
// tags, directives, document markers, `>` folded scalars, nested or
// multi-line flow collections, tabs, duplicate keys and the `<<` merge key
// are refused, as is any plain scalar the core schema would type by a rule
// not implemented here (`~`, `TRUE`, `0x1F`, `.inf`, ...) and any js-yaml
// would read as a date. Mappings come back with a null prototype. A stream of
// documents, each after a `---` line, is what pnpm 11 and later write where
// there is something to lock beside the project: the env document first, the
// project's lockfile second.
//
// With `workflow`, it reads the YAML GitHub reads a workflow or an action's
// metadata in too (workflow.js): a value left empty, null; a sequence under
// a key at the key's own column; `>` folded block scalars, a comment after a
// block scalar's header, and its indicators in either order; plain and
// quoted scalars and flow collections over more than one line, and flow
// collections nested, a comma after the last entry; anchors and aliases;
// and a tab in a block scalar's text. Scalars are typed as they are
// without it, and the rest is refused as it is: tags, merge keys, which
// GitHub doesn't read either, directives and end markers. With `lines`, a
// WeakMap, each block mapping and sequence is set in it to where its
// values are: a mapping's a Map by key, a sequence's an array, of the line
// each entry's key or `-` is on, counting from zero.

import { hex } from '../excerpt.js'
import { MAX_LINE, UNWRITTEN } from '../lines.js'
import { YamlError, excerpt } from './error.js'
import { parseInline, readKey, setKey, unescapeDouble } from './scalar.js'
import { checkExpanded, closingQuote, noTab, readAlias, readAnchor, readFlowLines, readPlainLines, readQuotedLines } from './workflow.js'

const MAX_DEPTH = 64
// A tab is let through to the parser, to be read in a block scalar's text
// alone (workflow.js noTab).
const WORKFLOW_UNWRITTEN = new RegExp(`(?!\t)${UNWRITTEN.source}`, 'u')

export function parseYaml(text, options) {
  const docs = parseYamlStream(text, options)
  if (docs.length !== 1) throw new YamlError(`expected a single document, found ${docs.length}`)
  return docs[0]
}

function readOptions(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('expected an options object')
  const unknown = Object.keys(options).find((key) => key !== 'workflow' && key !== 'lines')
  if (unknown !== undefined) throw new TypeError(`unknown option ${unknown}`)
  const { workflow = false, lines } = options
  if (typeof workflow !== 'boolean') throw new TypeError('expected workflow to be a boolean')
  if (lines !== undefined && !(lines instanceof WeakMap)) throw new TypeError('expected lines to be a WeakMap')
  return { workflow, lines }
}

// A document marker, `---` or `...`, which ends what is read over lines.
const isMarker = (line) => line.indent === 0 && /^(?:---|\.\.\.)(?: |$)/u.test(line.text)

export function parseYamlStream(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('expected a string')
  const doc = { text, pos: 0, number: -1, line: undefined, ...readOptions(options), anchors: null, aliased: false }
  if (doc.workflow) Object.assign(doc, { advance: () => advance(doc), isMarker })
  advance(doc)
  const docs = []
  skipMarker(doc)
  do docs.push(parseDocument(doc)); while (skipMarker(doc))
  return docs
}

// Steps over a `---` line when one is next, and says whether it did.
function skipMarker(doc) {
  if (peek(doc) !== undefined || doc.line === undefined) return false
  advance(doc)
  return true
}

function parseDocument(doc) {
  const first = peek(doc)
  if (first === undefined) throw new YamlError('empty document', doc.line?.number)
  if (first.indent !== 0) throw new YamlError('the document does not start at column 0', first.number)
  if (doc.workflow) Object.assign(doc, { anchors: new Map(), aliased: false })
  const value = parseNode(doc, 0, 0)
  if (doc.aliased) checkExpanded(value)
  if (peek(doc) !== undefined) throw new YamlError('unexpected content after the document', doc.line.number)
  if (typeof value !== 'object' || value === null) throw new YamlError('the document is a lone scalar, not a mapping or a sequence', first.number)
  return value
}

// Moves `doc.line` on to the next line, undefined past the last, and returns
// it. Lines are read only as the parser gets to them, so what a text costs
// in memory is what the document holds, not an object for each of its lines.
function advance(doc) {
  const { text, pos } = doc
  doc.line = undefined
  if (pos >= text.length) return undefined
  let end = text.indexOf('\n', pos)
  if (end === -1) end = text.length
  doc.pos = end + 1
  const number = ++doc.number
  if (text[end - 1] === '\r') end--
  // A scalar some 2^23 characters long runs V8's regex engine out of
  // backtracking stack, a RangeError rather than a YamlError: lines.js's
  // MAX_LINE holds a line to well below that.
  if (end - pos > MAX_LINE) throw new YamlError(`line longer than ${MAX_LINE} characters`, number)
  let start = pos
  while (text[start] === ' ') start++
  const line = text.slice(start, end)
  // Refused everywhere, tabs and other control characters among them; but
  // with `workflow` a tab, left to be read where it may be (workflow.js
  // noTab).
  const char = (doc.workflow ? WORKFLOW_UNWRITTEN : UNWRITTEN).exec(line)?.[0]
  if (char !== undefined) throw new YamlError(`${hex(char)} is not allowed`, number)
  doc.line = { indent: start - pos, text: line, number }
  return doc.line
}

// The next line of the document with something on it: blank and comment
// lines are skipped, and a `---` line ends the document, for the stream
// reader alone to step over. At column 0 `---` is a marker, refused with
// anything but spaces after it, since js-yaml reads `---x: 1` there as `---`
// then `x: 1`. `...` ends the document even where a key could be read
// (js-yaml writes `... k` unquoted); that and a `%` directive are refused.
function peek(doc) {
  let line = doc.line
  while (line !== undefined && (line.text === '' || line.text[0] === '#' || (doc.workflow && /^[\t ]*$/u.test(line.text)))) line = advance(doc)
  if (line !== undefined && doc.workflow) noTab(line)
  if (line?.indent !== 0 || !/^(?:---|\.\.\.(?: |$)|%)/u.test(line.text)) return line
  if (/^--- *$/u.test(line.text)) return undefined
  throw new YamlError(line.text.startsWith('---') ? 'content on the document marker line' : 'document end markers and directives are not supported', line.number)
}

const isEntry = (line) => /^-(?: |$)/u.test(line.text)
const isBlockScalar = (rest) => /^[|>]/u.test(rest)

function parseNode(doc, indent, depth) {
  const line = peek(doc)
  if (depth > MAX_DEPTH) throw new YamlError('nested too deep', line.number)
  if (isEntry(line)) return parseSequence(doc, indent, depth)
  const first = line.text.startsWith('? ') ? undefined : keyOf(doc, line)
  if (first !== null) return parseMapping(doc, indent, depth, first)
  advance(doc)
  return doc.workflow ? workflowValue(doc, line.text, line.indent - 1, depth, line) : parseInline(line.text, line.number)
}

// Every line at the indent is an entry, but from where `stop` says; a deeper
// one after the last is an error.
function parseBlock(doc, indent, entry, stop) {
  let line
  for (line = peek(doc); line?.indent === indent; line = peek(doc)) {
    if (stop?.(line)) return
    entry(line)
  }
  if (line?.indent > indent) throw new YamlError('bad indentation', line.number)
}

// `first`, the first line's key, read already where it has one.
function parseMapping(doc, indent, depth, first) {
  const map = Object.create(null)
  const lines = doc.lines && new Map()
  doc.lines?.set(map, lines)
  let read = first
  parseBlock(doc, indent, (line) => {
    if (!line.text.startsWith('? ')) {
      const entry = read ?? keyOf(doc, line)
      read = undefined
      if (entry === null) throw new YamlError(`expected a mapping key, found ${excerpt(line.text)}`, line.number)
      advance(doc)
      // An anchor before a key is the key's, as YAML has it, named before its value.
      if (entry.anchor) doc.anchors.set(entry.anchor, entry.key)
      setKey(map, entry.key, parseValue(doc, entry.rest, indent, depth, line), line.number)
      lines?.set(entry.key, line.number)
      return
    }
    advance(doc)
    const key = parseInline(line.text.slice(2), line.number)
    const next = peek(doc)
    if (next?.indent !== indent || !/^:(?: |$)/u.test(next.text)) throw new YamlError('expected ": " below the explicit key', (next ?? line).number)
    setKey(map, key, parseCompact(doc, next, indent, depth), line.number)
    lines?.set(key, line.number)
  })
  return map
}

// `underKey`, a sequence under a key at the key's own column, which ends
// where the mapping's next key is.
function parseSequence(doc, indent, depth, underKey = false) {
  const list = []
  const lines = doc.lines && []
  doc.lines?.set(list, lines)
  parseBlock(doc, indent, (line) => {
    if (!isEntry(line)) throw new YamlError(`expected "- ", found ${excerpt(line.text)}`, line.number)
    lines?.push(line.number)
    list.push(parseCompact(doc, line, indent, depth))
  }, underKey ? (line) => !isEntry(line) : undefined)
  return list
}

// What follows `key: `, `- ` or `: `: a block scalar, a node on the line, or,
// when nothing does, the deeper block below. YAML lets the entries of a
// sequence under a key sit at the key's own column; after `- ` they are the
// next entries of the same sequence.
function parseValue(doc, rest, indent, depth, owner) {
  if (doc.workflow) return workflowValue(doc, rest, indent, depth, owner)
  if (isBlockScalar(rest)) return readLiteral(doc, rest, indent, owner)
  if (rest !== '') return parseInline(rest, owner.number)
  const next = peek(doc)
  if (next?.indent === indent && isEntry(next) && !isEntry(owner)) throw new YamlError('a sequence under a key must be indented', next.number)
  if (next === undefined || next.indent <= indent) throw new YamlError('missing value', owner.number)
  return parseNode(doc, next.indent, depth + 1)
}

// After `- ` or `: ` a node may begin mid-line, with its further entries at
// that column below (`- a: 1` then `  b: 2`), so the line is reread as though
// it started at that column. What is stepped over is the indicator, its
// spaces, and a comment when that is all that follows.
function parseCompact(doc, line, indent, depth) {
  const spaces = /^[-:] *(?:#.*)?/u.exec(line.text)[0].length
  if (doc.workflow) return workflowCompact(doc, line, indent, depth, spaces)
  const rest = line.text.slice(spaces)
  if (rest === '' || isBlockScalar(rest)) {
    advance(doc)
    return parseValue(doc, rest, indent, depth, line)
  }
  doc.line = { ...line, indent: line.indent + spaces, text: rest }
  return parseNode(doc, line.indent + spaces, depth + 1)
}

// `|` with an optional indentation digit and chomping indicator: `-` drops
// every trailing line break, `+` keeps them all, neither keeps exactly one.
// Content is every line deeper than the enclosing block, blank ones included.
// Without the digit, its indentation is the deepest line's up to the first
// that is not blank, as YAML and js-yaml have it. Line breaks are counted,
// not kept, until something follows them.
function readLiteral(doc, header, indent, owner) {
  const { folded, digit, chomp } = blockHeader(doc, header, owner)
  let inner = indent + Number(digit)
  let known = digit !== ''
  let breaks = 0
  let body = ''
  // Where `folded`, whether the last line with something on it was indented
  // past the rest, which keeps the breaks around it; null before the first.
  let more = null
  for (let line = doc.line; line !== undefined && (line.text === '' || line.indent > indent); line = advance(doc)) {
    if (!known) inner = Math.max(inner, line.indent)
    known ||= line.text !== ''
    if (line.text !== '' && line.indent < inner) throw new YamlError('bad indentation in the block scalar', line.number)
    const content = `${' '.repeat(Math.max(line.indent - inner, 0))}${line.text}`
    if (content !== '') {
      const indented = /^[\t ]/u.test(content)
      body += folded ? foldedBreaks(breaks, more, indented) : '\n'.repeat(breaks)
      body += content
      more = indented
    }
    breaks = content === '' ? breaks + 1 : 1
  }
  return chomp === '+' ? body + '\n'.repeat(breaks) : chomp === '-' ? body : body && `${body}\n`
}

// `|`, or with `workflow`, `>` too, spaces or a comment after it, and the
// indicators in either order: whether it folds, its indentation digit and
// its chomping.
function blockHeader(doc, header, owner) {
  const m = doc.workflow ? /^([|>])(?:([1-9])([+-]?)|([+-])([1-9]?))?(?: +#.*| *)$/u.exec(header) : /^\|([1-9]?)([+-]?)$/u.exec(header)
  if (m === null) throw new YamlError(`unsupported block scalar ${excerpt(header)}`, owner.number)
  if (!doc.workflow) return { folded: false, digit: m[1], chomp: m[2] }
  return { folded: m[1] === '>', digit: m[2] ?? m[5] ?? '', chomp: m[3] || m[4] || '' }
}

// What a folded block scalar's `breaks` before a line come to: a space
// between two lines of its text, one break fewer than there are past an
// empty line, and all of them before its first or around one indented past
// the rest (`more`, `indented`).
const foldedBreaks = (breaks, more, indented) => more === null || more || indented ? '\n'.repeat(breaks) : breaks === 1 ? ' ' : '\n'.repeat(breaks - 1)

// A value as `workflow` reads it (`text`, what follows `key: ` or `- `,
// its owner's line read past): an anchor before it, then an alias, a block
// scalar, a flow collection, a quoted or plain scalar over its lines, or,
// where nothing is, the deeper block below, or a sequence under a key at
// the key's own column; else null.
function workflowValue(doc, text, indent, depth, owner) {
  const { anchor, rest } = readAnchor(text, owner.number)
  const value = workflowNode(doc, rest.startsWith('#') ? '' : rest, indent, depth, owner)
  if (anchor !== null) doc.anchors.set(anchor, value)
  return value
}

function workflowNode(doc, rest, indent, depth, owner) {
  if (rest.startsWith('*')) return readAlias(doc, rest, owner.number)
  if (isBlockScalar(rest)) return readLiteral(doc, rest, indent, owner)
  if (rest.startsWith('[') || rest.startsWith('{')) return parseInline(readFlowLines(doc, rest, owner, indent), owner.number, true)
  const quoted = rest.startsWith("'") || rest.startsWith('"')
  if (quoted && closingQuote(rest) === -1) return readQuotedLines(doc, rest, owner, unescapeDouble)
  if (rest !== '') return parseInline(quoted ? rest : readPlainLines(doc, rest, indent), owner.number, true)
  const next = peek(doc)
  if (next?.indent === indent && isEntry(next) && !isEntry(owner)) return parseSequence(doc, indent, depth + 1, true)
  if (next === undefined || next.indent <= indent) return null
  // A scalar on the lines below, its lines held deeper than its owner's.
  if (!isEntry(next) && !next.text.startsWith('? ') && keyOf(doc, next) === null) {
    advance(doc)
    return workflowValue(doc, next.text, indent, depth + 1, next)
  }
  return parseNode(doc, next.indent, depth + 1)
}

// An entry after `- `, or an explicit key's value after `: `, as `workflow`
// reads it: an anchor first, then a node starting mid-line, reread as
// though its line started there, or a value, its continuation lines held
// deeper than the `-`'s own column.
function workflowCompact(doc, line, indent, depth, spaces) {
  const text = line.text.slice(spaces)
  const { anchor, rest } = readAnchor(text, line.number)
  const column = line.indent + spaces
  if (rest !== '' && !rest.startsWith('#') && (isEntry({ text: rest }) || rest.startsWith('? '))) {
    if (anchor !== null) throw new YamlError('an anchor before a block on its own line is not supported', line.number)
    doc.line = { ...line, indent: column, text: rest }
    return parseNode(doc, column, depth + 1)
  }
  // A mapping, at the column after the indicator, an anchor before its
  // first key that key's (keyOf).
  if (rest !== '' && !rest.startsWith('#') && readKey(rest, line.number) !== null) {
    doc.line = { ...line, indent: column, text }
    return parseNode(doc, column, depth + 1)
  }
  advance(doc)
  const value = workflowNode(doc, rest.startsWith('#') ? '' : rest, indent, depth, line)
  if (anchor !== null) doc.anchors.set(anchor, value)
  return value
}

// A mapping's key at the start of a line, and what follows it; with
// `workflow`, an anchor before the key too, which is the key's.
function keyOf(doc, line) {
  if (!doc.workflow || !line.text.startsWith('&')) return readKey(line.text, line.number)
  const { anchor, rest } = readAnchor(line.text, line.number)
  const entry = readKey(rest, line.number)
  return entry && { ...entry, anchor }
}
