// The first step of Compare's diff with renamed names hidden (rename-diff.ts):
// the old side of a JavaScript file minified on both sides given the new
// side's names, wherever a minifier renamed a variable alike throughout, so
// that the two then diff as they are. Checked safe by oxc's own minifier: the
// renamed text binds every name as the old one did (bindsAlike).
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
// would not are renamed apart instead. The renamed text must then bind as the
// old one did by oxc's minifier, whose scope analysis is apart from this one,
// else it is not used: a mistake here costs a file its names, never its sense.
import { minifySync } from 'oxc-minify'
import { parseSync } from 'oxc-parser'
import { changeBlocks } from '../common/line-diff.js'

// Names a minifier gives: longer ones are an API's or a person's, and one
// changed is a change. ASCII alone, as a minifier gives: no name renamed to
// or from one a reader can't tell from another (Cyrillic `а` for `a`, or one
// with a zero-width joiner in it).
const RENAMED_MAX_LENGTH = 3
const MINIFIED = /^[A-Za-z_$][\w$]*$/u
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
// Words no variable may be named: reserved anywhere, in strict code or in a
// module, and the two strict code forbids binding.
const RESERVED = new Set(['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package',
  'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'yield', 'arguments', 'eval'])
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u

// A check that should never fail, a failure being a mistake here: the names
// are then not given (renameMap), and what failed is told.
class Broken extends Error {}
function holds(condition, what) {
  if (!condition) throw new Broken(what)
}

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

// Whether statements begin by saying their code is strict: among the strings
// they open with, which a statement of any other kind ends.
function saysStrict(statements) {
  for (const statement of statements) {
    if (typeof statement.directive !== 'string') return false
    if (statement.directive === 'use strict') return true
  }
  return false
}

const resolve = (name, from, names = at => at.names) => {
  for (let at = from; at; at = at.parent) if (names(at).has(name)) return names(at).get(name)
  return null
}
// A text's scopes and variables, each name in it a variable's (`occurrences`,
// with the scope it is read from, in order) or a global's (`globals`), or
// `{ reason }` where names can't all be followed: a text that does not parse
// (`unparsed`), reads a name by its spelling (`eval`, `with`: `dynamic`) or
// holds JSX (`jsx`), or, outside strict code, declares a function in a block,
// which there sets its function's variable of that name too (`block-function`).
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
    // With oxc's semantic errors too: a text it finds one in it can't vouch for.
    const parsed = parseSync('file.js', text, { lang: 'jsx', sourceType, showSemanticErrors: true })
    if (parsed.errors.length > 0) return { reason: 'unparsed' }
    program = parsed.program
  } catch { return { reason: 'unparsed' } }
  const declarations = new Map(), scopes = [], variables = []
  // Strict code is a module's, a class's, and a function's or a script's that
  // says so (`"use strict"`), with all within it.
  const scope = (parent, fn) => {
    const made = { parent, fn, names: new Map(), strict: parent?.strict ?? false }
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
  // Two variables that must keep one name, read from then on as the first.
  const join = (kept, gone) => {
    if (kept === gone || !variables.includes(gone)) return
    for (const path of gone.through ?? []) (kept.through ??= []).push(path)
    for (const at of scopes) for (const [name, variable] of at.names) if (variable === gone) at.names.set(name, kept)
    for (const [node, [variable, where]] of declarations) if (variable === gone) declarations.set(node, [kept, where])
    variables.splice(variables.indexOf(gone), 1)
  }
  // Names that are none of a variable's (a property, a key, a label), and
  // those whose variable keeps its name.
  const keeping = new Set(), others = new Set()
  const root = Object.assign(scope(null, true), { strict: program.sourceType === 'module' || saysStrict(program.body) })
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
        for (const declarator of node.declarations) {
          for (const id of declared(declarator.id)) {
            const variable = declare(node.kind === 'var' ? fnOf(where) : where, id)
            // A `var` written within blocks passes through each to its function's scope, innermost first.
            const path = []
            for (let at = where; node.kind === 'var' && !at.fn; at = at.parent) path.push(at)
            if (path.length > 0) (variable.through ??= []).push(path)
            // A `var` named as a `catch`'s parameter it is in declares its
            // function's, its value going to the nearest such parameter
            // (`catch (a) { var a = 2 }`): the two keep one name.
            for (let at = where; node.kind === 'var' && !at.fn; at = at.parent) {
              if (!at.caught || !at.names.has(id.name)) continue
              join(at.names.get(id.name), variable)
              break
            }
          }
        }
        break
      case 'FunctionDeclaration':
        if (node.id && !where.fn && !where.strict) return { reason: 'block-function' }
        if (node.id) declare(where, node.id)
        break
      // A function an `if` holds without braces is one in a block.
      case 'IfStatement':
        if (!where.strict && [node.consequent, node.alternate].some(clause => clause?.type === 'FunctionDeclaration')) return { reason: 'block-function' }
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
      if (node.body?.type === 'BlockStatement' && saysStrict(node.body.body)) parameters.strict = true
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
    else if (node.type === 'ClassBody') inner = Object.assign(scope(where, false), { strict: true })
    else if (node.type === 'StaticBlock') inner = scope(where, true)
    else if (node.type === 'CatchClause') {
      inner = Object.assign(scope(where, false), { caught: true, simple: node.param?.type === 'Identifier' })
      for (const id of declared(node.param)) declare(inner, id)
    }
    for (const field in node) {
      const value = node[field]
      if (Array.isArray(value)) { for (const child of value) if (child && typeof child.type === 'string') work.push([child, inner]) }
      // A switch's discriminant is read before its cases' scope is entered.
      else if (value && typeof value.type === 'string' && field !== 'type') work.push([value, field === 'discriminant' ? where : inner])
    }
  }
  // A `var` named as a name a block it hoists past declares does not compile
  // (`{ let a; { var a } }`), but past a `catch` whose simple parameter it is,
  // or past one of its name beyond such a one: a redeclaration oxc's semantic
  // check misses beside a `catch`, told here as one it finds.
  for (const variable of variables) {
    for (const path of variable.through ?? []) {
      let caught = false
      for (const at of path) {
        const there = at.names.get(variable.name)
        if (there === variable) caught ||= Boolean(at.caught)
        else if (there && !(at.caught && at.simple && caught)) return { reason: 'unparsed' }
      }
    }
  }
  // Every name read resolved, from where it is read outward; one no
  // declaration stands for is a global's.
  let commonjs = false
  const globals = [], occurrences = [...declarations].map(([node, [variable, where]]) => [node, variable, where])
  for (const [node, where] of references) {
    // `eval(…)` reads names by their spelling wherever `eval` is declared:
    // a variable holding the real one calls it as itself.
    if (node.name === 'eval') return { reason: 'dynamic' }
    const variable = resolve(node.name, where)
    if (variable) occurrences.push([node, variable, where])
    else {
      globals.push([node, where])
      if (COMMONJS.has(node.name)) commonjs = true
    }
  }
  for (const [node, variable] of occurrences) if (keeping.has(node)) variable.kept = true
  const own = program.sourceType === 'module' || program.sourceType === 'commonjs' || commonjs
  for (const variable of variables) variable.aside = variable.name.length <= RENAMED_MAX_LENGTH && MINIFIED.test(variable.name) && !variable.kept && (own || variable.scope !== root)
  // A shorthand property's two names are one, at one place.
  const byStart = (x, y) => x[0].start - y[0].start
  occurrences.sort(byStart)
  globals.sort(byStart)
  for (let i = 1; i < occurrences.length; i++) {
    const [[node, variable], [previous, other]] = [occurrences[i], occurrences[i - 1]]
    holds(node.start !== previous.start || variable === other, `${node.name} at ${node.start} two variables'`)
  }
  const deduplicated = occurrences.filter((entry, i) => i === 0 || entry[0].start !== occurrences[i - 1][0].start)
  const names = new Set([...variables.map(({ name }) => name), ...globals.map(([node]) => node.name)])
  return { scopes, variables, occurrences: deduplicated, globals, names, module: program.sourceType === 'module', commonjs: program.sourceType === 'commonjs', own }
}

// A text's analysis checked to hang together: each name it would rename
// written as that name where it is, read once and in order, none both a
// variable's and a global's, each variable declared and read by its own name,
// standing in its scopes by that name.
function checkAnalysis(text, { scopes, variables, occurrences, globals }) {
  const known = new Set(variables), read = new Set()
  let end = 0
  for (const [node, variable] of occurrences) {
    holds(known.has(variable), `${node.name} at ${node.start} read as a variable none declares`)
    holds(node.name === variable.name, `${node.name} at ${node.start} read as ${variable.name}`)
    holds(node.start >= end && node.end > node.start, `${node.name} at ${node.start} out of order`)
    holds(text.slice(node.start, node.end) === node.name, `${node.name} at ${node.start} written otherwise`)
    end = node.end
    read.add(node.start)
  }
  for (const [node] of globals) holds(!read.has(node.start), `${node.name} at ${node.start} both a variable's and a global's`)
  const standing = new Set(occurrences.map(([, variable]) => variable))
  for (const variable of variables) holds(standing.has(variable), `${variable.name} read nowhere`)
  for (const at of scopes) for (const [name, variable] of at.names) holds(known.has(variable) && variable.name === name, `a scope's ${name} no variable of its name`)
}

// Which old variable became which new one, checked: renamable variables
// alone, each new one taken once, the weak among those paired.
function checkPairing(a, b, { map, weak }) {
  const news = new Set(b.variables), taken = new Set()
  for (const [variable, to] of map) {
    holds(variable.aside && to.aside && news.has(to), `${variable.name} paired with ${to.name}, the two not both renamable`)
    holds(!taken.has(to), `two variables paired with ${to.name}`)
    taken.add(to)
  }
  for (const variable of weak) holds(map.has(variable), `${variable.name} weak, and paired with none`)
}

// The names given, checked: each changed one a renamable variable's, a name a
// variable may have, and either its counterpart's or one apart no side holds.
function checkGiven(a, b, map, given) {
  for (const variable of a.variables) {
    const name = given.get(variable)
    if (name === variable.name) continue
    holds(variable.aside, `${variable.name}, which keeps its name, named ${name}`)
    holds(IDENTIFIER.test(name) && MINIFIED.test(name) && !RESERVED.has(name), `${variable.name} named ${name}, which no variable may be`)
    holds(map.has(variable) ? map.get(variable).name === name : name.startsWith(variable.name + APART) && !a.names.has(name) && !b.names.has(name),
      `${variable.name} named ${name}, neither its counterpart's name nor one apart`)
  }
}

// The renamed text read again as the old one was: each name where it was,
// written as given, the names of one variable still one variable's and those
// of two still two's, and the same globals read.
function checkRenamed(a, given, text, extension) {
  const r = analyze(text, extension)
  holds(!r.reason, `the renamed text read again: ${r.reason}`)
  checkAnalysis(text, r)
  holds(r.occurrences.length === a.occurrences.length && r.globals.length === a.globals.length && r.variables.length === a.variables.length,
    'the renamed text reads another number of names')
  const backward = new Map(), forward = new Map()
  a.occurrences.forEach(([, variable], i) => {
    const [node, other] = r.occurrences[i]
    holds(node.name === given.get(variable), `${variable.name} written ${node.name}, not ${given.get(variable)}`)
    holds((forward.get(variable) ?? other) === other && (backward.get(other) ?? variable) === variable, `${variable.name}'s names read as another variable's`)
    forward.set(variable, other)
    backward.set(other, variable)
  })
  a.globals.forEach(([node], i) => holds(r.globals[i][0].name === node.name, `the global ${node.name} read as ${r.globals[i][0].name}`))
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
// scope named alike, a `var` named as one declared in a block it is written
// in (`{ let a; { var a } }` does not compile, and a `catch (a)` parameter
// would take its value, unless a nearer one of its own took it already), one
// of a function's body named as its parameter (which it would then be, or
// start as, past a default: `(a, b = 1) => { var c }` → `var b`), a name read
// resolving to another variable than its own, or a global's to a variable.
function misread({ scopes, variables, occurrences, globals }, given) {
  const names = new Map(scopes.map(at => [at, new Map()]))
  const wrong = new Set()
  for (const at of scopes) {
    for (const variable of at.names.values()) {
      const taken = names.get(at).get(given.get(variable))
      if (taken) wrong.add(taken).add(variable)
      else names.get(at).set(given.get(variable), variable)
    }
  }
  for (const variable of variables) {
    for (const path of variable.through ?? []) {
      let caught = false
      for (const at of path) {
        const there = names.get(at).get(given.get(variable))
        if (there === variable) caught ||= Boolean(at.caught)
        else if (there && !(at.caught && at.simple && caught)) wrong.add(there).add(variable)
      }
    }
  }
  for (const at of scopes) {
    if (!at.parameters) continue
    for (const variable of new Set(at.names.values())) {
      const parameter = names.get(at.parameters).get(given.get(variable))
      if (parameter && parameter !== variable) wrong.add(parameter).add(variable)
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

// Whether `renamed` binds as `before` does, by oxc's minifier: each mangled,
// every variable named by its place alone and never by its name, they read
// the same. A variable that would read another, a global one, a property or an
// export renamed, any of them makes the two differ. The top level as
// `analysis` (of the old text) has it: a module's or a CommonJS module's
// mangled with the rest, a script's, whose names are globals, left as it is.
// Each check holds where the other may not, and both must pass: oxc reads a
// function declared in a block as the block's alone even outside strict code
// (analyze refuses one: `block-function`), does not tell a `var` named as a
// `let` of a block it is written in (misread does), and reads a name beside a
// `catch`'s `var` of its parameter's name otherwise than JavaScript does.
export function bindsAlike(before, renamed, { module = false, commonjs = false, own = module || commonjs } = {}) {
  const file = module ? 'file.mjs' : commonjs ? 'file.cjs' : 'file.js'
  const mangled = text => {
    try {
      const result = minifySync(file, text, { module, compress: false, mangle: { toplevel: own }, codegen: { removeWhitespace: true } })
      return result.errors.length === 0 ? result.code : null
    } catch { return null }
  }
  const code = mangled(before)
  return code !== null && code === mangled(renamed)
}

// The old text with the new one's names, as above: `{ text, renamed, apart,
// kind }`, counting the variables renamed to a new one's name and those
// renamed apart, `kind` how bindsAlike reads the old text; or `{ reason }`
// where it can't be, as analyze has it, or where the renamed text would not
// bind as the old one does (`unverified`), with what failed (`invariant`)
// where a check that should never fail did, or anything else went wrong: a
// mistake here shows a file with its names, never with names it does not
// have. The old text a file's with `extension`, the new one with
// `otherExtension`.
export function renameMap(before, after, options = {}) {
  try { return renamedNames(before, after, options) }
  catch (err) { return { reason: 'unverified', invariant: err instanceof Broken ? err.message : `${err?.name ?? 'Error'}: ${err?.message ?? err}` } }
}

function renamedNames(before, after, { extension = 'js', otherExtension = extension }) {
  const a = analyze(before, extension), b = analyze(after, otherExtension)
  if (a.reason || b.reason) return { reason: a.reason ?? b.reason }
  checkAnalysis(before, a)
  checkAnalysis(after, b)
  const { map, weak } = pairing(before, after, a, b)
  checkPairing(a, b, { map, weak })
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
  checkGiven(a, b, map, given)
  let at = 0, text = ''
  for (const [node, variable] of a.occurrences) {
    text += before.slice(at, node.start) + given.get(variable)
    at = node.end
  }
  text += before.slice(at)
  holds(before !== after || text === before, 'a text renamed as itself changed')
  checkRenamed(a, given, text, extension)
  if (!bindsAlike(before, text, a)) return { reason: 'unverified' }
  let renamed = 0, separated = 0
  for (const variable of a.variables) {
    if (given.get(variable) === variable.name) continue
    if (map.has(variable)) renamed++
    else separated++
  }
  return { text, renamed, apart: separated, kind: { module: a.module, commonjs: a.commonjs, own: a.own } }
}
