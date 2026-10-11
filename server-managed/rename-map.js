// The first step of Compare's diff with renamed names hidden (rename-diff.ts):
// the old side of a JavaScript file minified on both sides given the new
// side's names, wherever a minifier renamed a variable alike throughout, so
// that the two then diff as they are. Checked safe: the renamed text reads
// every name as the old one did.
//
// Both sides are parsed (oxc-parser) and each name resolved, by JavaScript's
// scopes, to the variable it stands for. Lines pair up as they are with their
// variables' short names set aside, and every pair tells which variable
// became which: an old one and a new one each the other's most told of
// (pairing) is renamed to the new one's name, on every line, removed ones too
// (a changed line's variables count where unchanged lines say nothing). Any
// other old variable whose name the new side uses is renamed apart (`r_old`),
// as it is none of the new side's: a line reading it never reads as one
// reading the new side's. The names so given must leave each name read where
// it was resolving to the same variable, a global's to none, and those that
// would not are renamed apart instead; the renamed text is then parsed again
// and must bind as the old one did, else it is not used.
import { parseSync } from 'oxc-parser'
import { changeBlocks } from '../common/line-diff.js'

// Names a minifier gives: longer ones are an API's or a person's, and one
// changed is a change.
const RENAMED_MAX_LENGTH = 3
// What a name renamed apart ends in, numbered past the first as it takes to
// be one neither side uses: `e_old`, `e_old2`.
const APART = '_old'
// The fewest unchanged lines in a row between changes whose pairs count as
// unchanged lines do in pairing variables.
const ANCHORED_RUN = 3
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
// What holds `let`, `const`, `class` and functions declared in it as its own.
const BLOCKS = new Set(['BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement'])
// A CommonJS module's own names, read where no declaration stands for them:
// its top level is a function's, not every script's.
const COMMONJS = new Set(['exports', 'module', 'require'])

// The names a pattern declares: `{ a, b: [c, ...d] = e }` declares a, c and d.
function declared(pattern, out = []) {
  switch (pattern?.type) {
    case 'Identifier': out.push(pattern); break
    case 'ObjectPattern': for (const property of pattern.properties) declared(property.type === 'RestElement' ? property.argument : property.value, out); break
    case 'ArrayPattern': for (const element of pattern.elements) declared(element, out); break
    case 'RestElement': declared(pattern.argument, out); break
    case 'AssignmentPattern': declared(pattern.left, out); break
    default: break
  }
  return out
}

const resolve = (name, from, names = at => at.names) => {
  for (let at = from; at; at = at.parent) if (names(at).has(name)) return names(at).get(name)
  return null
}
const within = (from, of) => {
  for (let at = from; at; at = at.parent) if (at === of) return true
  return false
}

// A text's scopes and variables, each name in it a variable's (`occurrences`,
// with the scope it is read from, in order) or a global's (`globals`), or
// `{ reason }` where names can't all be followed: a text that does not parse
// (`unparsed`), reads a name by its spelling (`eval`, `with`: `dynamic`) or
// holds JSX (`jsx`), or, outside a module, reads a function declared in a
// block past it, its function's in sloppy code alone (`block-function`).
// Parsed as its `extension` has it: an `.mjs` file a module, a `.cjs` one a
// CommonJS module, any other a module where it says so (`import`, `export`).
// A variable is renamable (`aside`) where its name is short and a declaration
// stands for it (`var`, `let`, `const`, `function`, `class`, `import`,
// `catch`, parameters), but not at a script's top level, where it is a global
// another script may read, nor where its name is part of what the file says:
// exported by that name (`export { a }`, `export const a`), imported by it
// (`import { a }`), or a shorthand property's (`{ a }`, `const { a } = o`).
// Properties, keys, labels and strings are no variable's.
function analyze(text, extension) {
  let program
  try {
    const sourceType = extension === 'mjs' ? 'module' : extension === 'cjs' ? 'commonjs' : 'unambiguous'
    const parsed = parseSync('file.js', text, { lang: 'jsx', sourceType })
    if (parsed.errors.length > 0) return { reason: 'unparsed' }
    program = parsed.program
  } catch { return { reason: 'unparsed' } }
  const blockFunctions = [], declarations = new Map(), scopes = [], variables = []
  const scope = (parent, fn) => {
    const made = { parent, fn, names: new Map() }
    scopes.push(made)
    return made
  }
  // A function body's `var` or function named as one of its parameters is
  // that parameter (`function f(a) { var a; return a }` returns its argument).
  const declare = (where, node) => {
    if (where.parameters?.names.has(node.name)) where = where.parameters
    let variable = where.names.get(node.name)
    if (!variable) {
      where.names.set(node.name, variable = { id: variables.length, name: node.name, scope: where, kept: false, aside: false })
      variables.push(variable)
    }
    declarations.set(node, [variable, where])
    return variable
  }
  const fnOf = where => where.fn ? where : fnOf(where.parent)
  // Names that are none of a variable's (a property, a key, a label), and
  // those whose variable keeps its name.
  const keeping = new Set(), others = new Set()
  const root = scope(null, true)
  // Each node with the scope it is read in, a work list rather than a
  // recursion, as a minified file's expressions can nest deeply.
  const references = [], work = [[program, root]]
  while (work.length > 0) {
    const [node, where] = work.pop()
    switch (node.type) {
      case 'Identifier':
        if (!declarations.has(node) && !others.has(node)) references.push([node, where])
        continue
      case 'JSXElement': case 'JSXFragment': return { reason: 'jsx' }
      case 'WithStatement': return { reason: 'dynamic' }
      case 'VariableDeclaration':
        for (const declarator of node.declarations) for (const id of declared(declarator.id)) declare(node.kind === 'var' ? fnOf(where) : where, id)
        break
      case 'FunctionDeclaration':
        if (node.id && !where.fn) blockFunctions.push(declare(where, node.id))
        else if (node.id) declare(where, node.id)
        break
      case 'ClassDeclaration': if (node.id) declare(where, node.id); break
      case 'ImportDeclaration':
        for (const specifier of node.specifiers) {
          declare(root, specifier.local)
          if (specifier.type !== 'ImportSpecifier') continue
          others.add(specifier.imported)
          if (specifier.imported.start === specifier.local.start) keeping.add(specifier.local)
        }
        break
      case 'ExportNamedDeclaration':
        for (const specifier of node.specifiers) {
          others.add(specifier.exported)
          if (node.source) others.add(specifier.local)
          else if (specifier.exported.start === specifier.local.start) keeping.add(specifier.local)
        }
        if (node.declaration?.type === 'VariableDeclaration') for (const declarator of node.declaration.declarations) for (const id of declared(declarator.id)) keeping.add(id)
        else if (node.declaration?.id) keeping.add(node.declaration.id)
        break
      case 'ExportDefaultDeclaration': if (node.declaration.id) keeping.add(node.declaration.id); break
      case 'ExportAllDeclaration': if (node.exported) others.add(node.exported); break
      case 'ImportAttribute': others.add(node.key); break
      case 'MemberExpression': if (!node.computed) others.add(node.property); break
      case 'Property': case 'MethodDefinition': case 'PropertyDefinition': case 'AccessorProperty':
        if (node.computed) break
        if (node.shorthand) keeping.add(node.key)
        else others.add(node.key)
        break
      case 'LabeledStatement': case 'BreakStatement': case 'ContinueStatement': if (node.label) others.add(node.label); break
      case 'MetaProperty': others.add(node.meta).add(node.property); break
      default: break
    }
    // A function's parameters are a scope, its body's declarations one apart
    // (a default reads none of them: `(a = b) => { var b }`), and a function
    // or class expression's own name one around both.
    if (FUNCTIONS.has(node.type) || node.type === 'ClassExpression') {
      const named = node.type !== 'FunctionDeclaration' && node.id ? scope(where, false) : where
      if (named !== where) declare(named, node.id)
      if (node.type === 'ClassExpression') {
        for (const child of [node.superClass, node.body, ...node.decorators ?? []]) if (child) work.push([child, named])
        continue
      }
      const parameters = scope(named, true)
      for (const parameter of node.params) {
        for (const id of declared(parameter)) declare(parameters, id)
        work.push([parameter, parameters])
      }
      if (node.body?.type === 'BlockStatement') {
        const body = Object.assign(scope(parameters, true), { parameters })
        for (const statement of node.body.body) work.push([statement, body])
      } else if (node.body) work.push([node.body, parameters])
      continue
    }
    let inner = where
    if (BLOCKS.has(node.type)) inner = scope(where, false)
    else if (node.type === 'StaticBlock') inner = scope(where, true)
    else if (node.type === 'CatchClause') {
      inner = scope(where, false)
      for (const id of declared(node.param)) declare(inner, id)
    }
    for (const field in node) {
      const value = node[field]
      if (Array.isArray(value)) { for (const child of value) if (child && typeof child.type === 'string') work.push([child, inner]) }
      else if (value && typeof value.type === 'string' && field !== 'type') work.push([value, inner])
    }
  }
  // Every name read resolved, from where it is read outward; one no
  // declaration stands for is a global's.
  let commonjs = false
  const globals = [], occurrences = [...declarations].map(([node, [variable, where]]) => [node, variable, where])
  for (const [node, where] of references) {
    const variable = resolve(node.name, where)
    if (variable) occurrences.push([node, variable, where])
    else if (node.name === 'eval') return { reason: 'dynamic' }
    else {
      globals.push([node, where])
      if (COMMONJS.has(node.name)) commonjs = true
    }
    if (program.sourceType !== 'module'
      && blockFunctions.some(fn => fn.name === node.name && fn !== variable && !within(where, fn.scope) && within(where, fnOf(fn.scope)))) return { reason: 'block-function' }
  }
  for (const [node, variable] of occurrences) if (keeping.has(node)) variable.kept = true
  const own = program.sourceType === 'module' || program.sourceType === 'commonjs' || commonjs
  for (const variable of variables) variable.aside = variable.name.length <= RENAMED_MAX_LENGTH && !variable.kept && (own || variable.scope !== root)
  // A shorthand property's two names are one, at one place.
  const byStart = (x, y) => x[0].start - y[0].start
  occurrences.sort(byStart)
  globals.sort(byStart)
  const deduplicated = occurrences.filter((entry, i) => i === 0 || entry[0].start !== occurrences[i - 1][0].start)
  const names = new Set([...variables.map(({ name }) => name), ...globals.map(([node]) => node.name)])
  return { scopes, variables, occurrences: deduplicated, globals, names }
}

// A text's lines with its renamable variables' names set aside (`key`), and
// each line's such variables in order (`lines`).
function keyed(text, { occurrences }) {
  const starts = [0]
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1)
  const lines = starts.map(() => [])
  let at = 0, key = '', line = 0
  for (const [node, variable] of occurrences) {
    if (!variable.aside) continue
    key += text.slice(at, node.start)
    at = node.end
    while (line + 1 < starts.length && starts[line + 1] <= node.start) line++
    lines[line].push(variable)
  }
  return { key: key + text.slice(at), lines }
}

// Which old variable became which new one. Every pair of lines counts each
// variable as standing for the other in it, and an old variable and a new one
// pair where each is the other's most counted of those not yet paired, a tie
// pairing neither, until none more do: a stray pair of lines (`e = a;` beside
// another function's `e = n;`) outweighed, and one paired leaving the next
// its due (`var a, b; f(a); g(b)` → `var c, d; f(c); g(c)` pairs a with c, then
// b with d). Lines pair as the diff of their keys has them unchanged; then, for
// variables those say nothing of, the lines of a change of as many lines on
// each side, in order (`n => n * 2` → `n => n * 3`), which can so never undo
// what unchanged lines say: those so paired are `weak`, the first to give way
// where names would read wrongly.
function pairing(before, after, a, b) {
  const ka = keyed(before, a), kb = keyed(after, b)
  const tallies = () => ({ backward: new Map(), forward: new Map() })
  const count = (map, from, to) => {
    if (!map.has(from)) map.set(from, new Map())
    map.get(from).set(to, (map.get(from).get(to) ?? 0) + 1)
  }
  const tally = ({ backward, forward }, pa, pb) => {
    const news = kb.lines[pb], olds = ka.lines[pa]
    // A pair reading variables on one side its other does not (`{ a }`
    // declared on one alone) says nothing of which became which.
    if (olds.length !== news.length) return
    olds.forEach((variable, k) => { count(forward, variable, news[k]); count(backward, news[k], variable) })
  }
  const changed = tallies(), unchanged = tallies()
  let i = 0, j = 0
  // Lines differing in whitespace alone pair too: it never tells a name apart.
  for (const block of [...changeBlocks(ka.key, kb.key, true), { a0: ka.lines.length, a1: ka.lines.length, b0: kb.lines.length, b1: kb.lines.length }]) {
    // A short run of unchanged lines between changes may pair two alike lines
    // of different places (`function K(t, e) {` with an added `function ls(t,
    // e) {`, their names set aside): told as a changed line is.
    const anchored = block.a0 - i >= ANCHORED_RUN
    while (i < block.a0) tally(anchored ? unchanged : changed, i++, j++)
    if (block.a1 - block.a0 === block.b1 - block.b0) for (let k = 0; k < block.a1 - block.a0; k++) tally(changed, block.a0 + k, block.b0 + k)
    i = block.a1
    j = block.b1
  }
  const map = new Map(), paired = new Set(), weak = new Set()
  // The most counted of those not yet paired, none where two tie.
  const best = (counts, taken) => {
    let found = null, most = 0
    for (const [other, n] of counts) {
      if (taken(other)) continue
      if (n > most) { found = other; most = n }
      else if (n === most) found = null
    }
    return found
  }
  const match = ({ backward, forward }, eligible = () => true) => {
    const chosen = []
    for (let more = true; more;) {
      more = false
      for (const [variable, counts] of forward) {
        if (map.has(variable)) continue
        const to = best(counts, other => paired.has(other))
        if (!to || best(backward.get(to), other => map.has(other)) !== variable || !eligible(variable, to)) continue
        map.set(variable, to)
        paired.add(to)
        chosen.push(variable)
        more = true
      }
    }
    return chosen
  }
  match(unchanged)
  for (const variable of match(changed, (old, to) => !unchanged.forward.has(old) && !unchanged.backward.has(to))) weak.add(variable)
  return { map, weak }
}

// The variables the names given (`given`) would read wrongly: two of one
// scope named alike, a name read resolving to another variable than its own,
// or a global's to a variable.
function misread({ scopes, occurrences, globals }, given) {
  const names = new Map(scopes.map(at => [at, new Map()]))
  const wrong = new Set()
  for (const at of scopes) {
    for (const variable of at.names.values()) {
      const taken = names.get(at).get(given.get(variable))
      if (taken) wrong.add(taken).add(variable)
      else names.get(at).set(given.get(variable), variable)
    }
  }
  const named = at => names.get(at)
  for (const [, variable, where] of occurrences) {
    const found = resolve(given.get(variable), where, named)
    if (found !== variable) { wrong.add(variable); if (found) wrong.add(found) }
  }
  for (const [node, where] of globals) {
    const found = resolve(node.name, where, named)
    if (found) wrong.add(found)
  }
  return wrong
}

// Whether `renamed` binds as `analysis` (of the text it was renamed from)
// does: the same names in the same places, each read of one variable there
// one of one variable here, and the same globals read.
function bindsAlike(analysis, renamed) {
  if (renamed.reason || renamed.occurrences.length !== analysis.occurrences.length || renamed.globals.length !== analysis.globals.length) return false
  const backward = new Map(), forward = new Map()
  return analysis.occurrences.every(([, variable], i) => {
    const other = renamed.occurrences[i][1]
    if ((forward.get(variable) ?? other) !== other || (backward.get(other) ?? variable) !== variable) return false
    forward.set(variable, other)
    backward.set(other, variable)
    return true
  }) && analysis.globals.every(([node], i) => renamed.globals[i][0].name === node.name)
}

// The old text with the new one's names, as above: `{ text, renamed, apart }`,
// counting the variables renamed to a new one's name and those renamed apart,
// or `{ reason }` where it can't be, as analyze has it, or where the renamed
// text would not bind as the old one does (`unverified`); the old text a
// file's with `extension`, the new one with `otherExtension`.
export function renameMap(before, after, { extension = 'js', otherExtension = extension } = {}) {
  const a = analyze(before, extension), b = analyze(after, otherExtension)
  if (a.reason || b.reason) return { reason: a.reason ?? b.reason }
  const { map, weak } = pairing(before, after, a, b)
  const apart = name => {
    let named = name + APART
    for (let n = 2; a.names.has(named) || b.names.has(named); n++) named = `${name}${APART}${n}`
    return named
  }
  const given = new Map()
  for (;;) {
    for (const variable of a.variables) {
      const own = variable.aside && !map.has(variable) && b.names.has(variable.name) ? apart(variable.name) : variable.name
      given.set(variable, variable.aside && map.has(variable) ? map.get(variable).name : own)
    }
    const wrong = [...misread(a, given)]
    if (wrong.length === 0) break
    // Renamed apart instead, a name no side holds, a changed line's pairing
    // first; what can't be is no rename.
    const yielding = wrong.some(variable => weak.has(variable) && map.has(variable)) ? wrong.filter(variable => weak.has(variable)) : wrong
    const dropped = yielding.filter(variable => map.delete(variable))
    if (dropped.length === 0) return { reason: 'unverified' }
  }
  let at = 0, text = ''
  for (const [node, variable] of a.occurrences) {
    text += before.slice(at, node.start) + given.get(variable)
    at = node.end
  }
  text += before.slice(at)
  if (!bindsAlike(a, analyze(text, extension))) return { reason: 'unverified' }
  let renamed = 0, separated = 0
  for (const variable of a.variables) {
    if (given.get(variable) === variable.name) continue
    if (map.has(variable)) renamed++
    else separated++
  }
  return { text, renamed, apart: separated }
}
