// The diff of two JavaScript files minified on both sides with the names a
// minifier renamed alike left out, as Compare's "Hide renamed names" shows it:
// worked out by the server (server-managed/rename-diff.ts) from the two files
// pretty-printed, its viewer drawing the blocks it is given.
import { changeBlocks, textLines } from './line-diff.js'

// Words a minifier never renames, kept as they are when names are set aside.
const KEYWORDS = new Set(['arguments', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'eval', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get',
  'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'package', 'private', 'protected',
  'public', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void',
  'while', 'with', 'yield', 'Infinity', 'NaN'])
// Names a minifier gives: longer ones are an API's or a person's, and one
// changed is a change.
const RENAMED_MAX_LENGTH = 3
// What a text is read in, from where it is: a string, a template's text (to
// its end or a substitution's `${`, whose code is read as any, the text going
// on after its `}`: TEMPLATE), a comment (a hashbang too, its first line, and
// a script's `<!--` or line-opening `-->`), a regular expression (where a
// value starts: `/` after one divides), a name (as JavaScript tells its
// characters: `a\u200Cb` is one), a bracket, or what lies between, operators
// and numbers.
const READ = /"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|`(?:[^`\\$]|\\[\s\S]|\$(?!\{))*(?:`|\$\{)|\/\/.*|<!--.*|(?<=(?:^|\n)[ \t]*)-->.*|(?<![\s\S])#!.*|\/\*[\s\S]*?(?:\*\/|$)|\/(?:[^/\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*|(?<![\p{ID_Continue}$\\\u200C\u200D]|(?<!\.\.)\.)[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*|[()[\]{}]/gu
// What a line ending in goes on past its line break: an operator, not a
// postfix `++` or `--` (`a++⏎b`).
const CONTINUES = /(?<![+-])[,=+\-*/%&|^<>?:!~.]$|(?<=[^+]|^)\+$|(?<=[^-]|^)-$/u
// A value's end in what lies before a `/`, which then divides: a postfix
// `++` or `--` (`x++ / y`), a prefix one there updating a regular expression,
// an odd run of signs ending in a `+` or `-` of its own, a value to follow
// (`x+++/a/`); or a number's trailing `.` (`1. / y`), a property's `.`
// before a `/` being no JavaScript.
const VALUE_END = /(?<!\+)(?:\+\+)+$|(?<!-)(?:--)+$|\d\.$/u
// The comments READ reads, in what lies between.
const COMMENT = /\/\/.*|<!--.*|(?<=(?:^|\n)[ \t]*)-->.*|(?<![\s\S])#!.*|\/\*[\s\S]*?(?:\*\/|$)/gu
// A template's text after a substitution's `}`, to its end or the next `${`.
const TEMPLATE = /(?:[^`\\$]|\\[\s\S]|\$(?!\{))*(?:`|\$\{)/uy
// Words after which a value starts, so a `/` begins a regular expression.
const BEFORE_VALUE = new Set(['await', 'case', 'default', 'delete', 'do', 'else', 'extends', 'in', 'instanceof', 'new', 'of', 'return',
  'throw', 'typeof', 'void', 'yield'])
// Words a line break after ends their statement, whatever follows.
const RESTRICTED = new Set(['break', 'continue', 'debugger', 'return', 'yield'])
// Words a `{` after which opens a block, as do `)`, `;`, `{`, `}`, `=>` and
// the start; any other opens an object, a pattern or a class body.
const BEFORE_BLOCK = new Set(['catch', 'do', 'else', 'finally', 'try'])
// Words between a key's place and its key: `{ async a() {} }`.
const MODIFIERS = new Set(['accessor', 'async', 'get', 'set', 'static'])
// Words whose `(…)` a statement follows (`if (a) /b/.test(c)`), declaring
// nothing as a function's `(…)` does.
const CONTROL = new Set(['for', 'if', 'switch', 'while', 'with'])
// Words between `export` and the name it exports: `export async function a`,
// `export * as a`.
const DECLARES = new Set(['as', 'async', 'class', 'function'])
// Words the name after which a file declares: `function a`, `import b`.
const NAMING = new Set(['as', 'class', 'function', 'import'])
// Spaces or comments, what may lie between a token and the next.
const TRIVIA = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/.*)*`
// After a function's `(…)` or a lone parameter, with or without a body.
const BODY = new RegExp(String.raw`${TRIVIA}(?:=>${TRIVIA})?\{`, 'uy')
const ARROW = new RegExp(`${TRIVIA}=>`, 'uy')
const ARROW_BODY = new RegExp(String.raw`${TRIVIA}=>${TRIVIA}\{`, 'uy')
// What a `let` declaring follows with, a name or a pattern: not `let(a)`,
// a call where `let` is a name, as it may be outside strict code.
const LET = new RegExp(String.raw`${TRIVIA}[\p{L}_$[{]`, 'uy')
// What ends a concise arrow's body or begins a conditional in it: a `?` (not
// `?.`, `??`), a `:`, a `,` or a `;`.
const ARROW_ENDS = /(?<!\?)\?(?!\?|\.(?!\d))|[:,;]/gu
// What follows a `for`'s `(…)` whose body is braced, and an unbraced body's
// statement still going on: an `if`'s `else`, a `try`'s `catch` or
// `finally`, a `do`'s `while`; spaces or comments first.
const BRACED = new RegExp(String.raw`${TRIVIA}\{`, 'uy')
const GOES_ON = new RegExp(String.raw`${TRIVIA}(catch|else|finally|while)(?![\p{ID_Continue}$])`, 'uy')
// What follows a shorthand property: spaces or comments, then `,`, `}` or a
// pattern's default's `=`.
const SHORTHAND = new RegExp(String.raw`${TRIVIA}(?:[,}]|=(?![=>]))`, 'uy')
// What follows a local name an `export { … }` renames.
const AS = new RegExp(String.raw`${TRIVIA}as(?![\p{ID_Continue}$])`, 'uy')
// What follows a name in an `export { … }` that re-exports another module's.
const EXPORT_FROM = /[^}]*\}\s*from(?![\p{ID_Continue}$])/uy
// A word that begins a line going on the line before: `x⏎instanceof a`.
const INFIX = /(?:in|instanceof)(?![\p{ID_Continue}$])/uy
// What follows a key before its value: spaces or comments, then `:`.
const KEYED = new RegExp(`${TRIVIA}:`, 'uy')
// What follows an `import` that is no module's, a call (`import(…)`): not
// `import.meta`, a module's alone.
const IMPORT_CALL = new RegExp(String.raw`${TRIVIA}\(`, 'uy')
// What follows a CommonJS module's own names, its top level a function's:
// `require(…)`, `module.exports`, `exports.…`.
const COMMONJS = new Map([['exports', new RegExp(String.raw`${TRIVIA}\.`, 'uy')],
  ['module', new RegExp(String.raw`${TRIVIA}\.${TRIVIA}exports(?![\p{ID_Continue}$])`, 'uy')], ['require', new RegExp(String.raw`${TRIVIA}\(`, 'uy')]])
// What a set-aside name leaves in its line.
const NAMELESS = ''

// A text with its short names set aside (`key`, its lines where the text's
// are), and each line's names in order (`names`). Read as a whole, so a
// comment or a template spanning lines keeps all of them. Set aside only
// where a declaration in scope stands for them (`var`, `let`, `const`,
// `function`, `class`, `import`, `catch` and parameters), a global (`Map`,
// `$`) being no minifier's to rename. Kept as they are: strings, templates, comments,
// regular expressions, keywords, names longer than a minifier gives,
// properties: after `.`, before `:`, or in an object's, a pattern's or a
// class's key place (`{ a, b() {}, c = 1 }`), and what a module exports
// (`export { a as b }`, `export const c = 1`), since renaming one changes
// what reads it.
function nameless(text) {
  // `program` the text as code, a string, template or regular expression
  // `""` and a comment its line breaks: what JSX is looked for in.
  const key = [], names = [[]], program = [], setAside = []
  const opens = []
  // Each block a scope, declaring what is declared in it (its function's
  // parameters too, and a function expression's own name, `pending` until it
  // opens, each read from it), seen from it and the blocks in it. So are a
  // concise arrow's body (`arrows`, the depths where a `,` or `;` ends it,
  // with the conditionals begun in it whose `:` does not)
  // and a `for` from its `(` to the end of its body (`loops`). A `var` is
  // its function's (`fn`, the top level's too), any other declaration its
  // block's; what a function's parameters read is in their scope
  // (`(a, b = a) =>`), the scopes in them too (`pendingGroup` the group
  // they are of, until its body).
  const scopes = [{ fn: true, names: new Set(), parent: -1 }]
  const arrows = [], loops = []
  let pending = null, pendingGroup = null, scope = 0, self = null
  // Each class until its body (`classes`, with the `extends` marker its body
  // takes, if any), and each class's body (`classBodies`, their depths): a
  // named class expression's name is a scope from it to its body's end
  // (`scoped`), its `extends` too.
  const classBodies = [], classes = []
  // A function declared in a block, with the block (`blockFunctions`): outside
  // a module, its function's too where the code is not strict, unknown here.
  const blockFunctions = []
  const declare = (name, hoisted = false) => {
    let at = scope
    if (hoisted) while (!scopes[at].fn) at = scopes[at].parent
    scopes[at].names.add(name)
  }
  const enter = (entries = [], { fn = false, group = null } = {}) => {
    const outer = scope
    scopes.push({ fn: fn && !group, names: new Set(entries.map(({ name }) => name)), params: group !== null, parent: scope })
    scope = scopes.length - 1
    for (const { aside } of entries) if (aside) aside[3] = scope
    if (!group) return
    for (let i = group.asides; i < setAside.length; i++) if (setAside[i][3] === outer) setAside[i][3] = scope
    for (let i = group.scopes; i < scope; i++) if (scopes[i].parent === outer) scopes[i].parent = scope
    // Its body's declarations a scope apart, a default reading none (`(a = b) => { var b }`).
    scopes.push({ fn, names: new Set(), parent: scope })
    scope = scopes.length - 1
  }
  // Left, a body leaves its parameters' scope too.
  const leave = () => {
    scope = scopes[scope].parent
    if (scopes[scope].params) scope = scopes[scope].parent
  }
  // A conditional's `:` (`colon`) is the innermost one's begun, ending the
  // arrows begun after its `?` alone.
  const endArrows = (depth, colon = false) => {
    while (arrows.length > 0 && arrows.at(-1).depth >= depth) {
      if (colon && arrows.at(-1).conditionals > 0) return void arrows.at(-1).conditionals--
      arrows.pop()
      leave()
    }
  }
  // A braced body ends at its `}`; an unbraced one with its statement, an
  // `if`'s with its `else` (`for (…) if (x) f(); else g()`), a `try`'s with
  // its `catch` or `finally`, a `do`'s (`doing`, those begun in it) with its `while`, read from
  // `from`: a `while` past a body that is no `do` begins one of its own.
  const endLoops = (depth, from) => {
    GOES_ON.lastIndex = from
    const next = GOES_ON.exec(text)?.[1]
    while (loops.length > 0 && loops.at(-1).body && loops.at(-1).depth >= depth) {
      const loop = loops.at(-1)
      if (!loop.braced && next && (next !== 'while' || loop.doing > 0)) return void (loop.doing -= next === 'while' ? 1 : 0)
      scope = scopes[loops.pop().scope].parent
    }
  }
  // In a `for`'s `(…)`, where `of` is its word: a name elsewhere (`of⏎a()`).
  const inHead = () => loops.at(-1)?.body === false && loops.at(-1).depth === opens.length - 1
  // Whether a `/` divides, after the word or mark `word` and the code `code`
  // between: after a value, `of` a name there (`of / 2`).
  const divides = (word, code) => /^[\p{L}\p{N}_$)\]"]$/u.test(word)
    || (word?.length > 1 && (!BEFORE_VALUE.has(word) || (word === 'of' && !inHead()))) || VALUE_END.test(code.trimEnd())
  // Where a statement starts, a `function` or `class` declares its name: after
  // `else` too, a function declared there its function's outside strict code
  // (`else function a() {}`), as one in a block is.
  const statement = word => word === null || word === ';' || word === '{' || word === '}' || word === 'export' || word === 'default' || word === 'else'
  // A script's top level is every script's: a name declared there is a
  // global another may read (`var a` in one, `a()` in the next), kept. A
  // module's (`import`, `export`) or a CommonJS one's, a function's, is its
  // own: by its `require`, `module` or `exports` (`commonjs`, each with its
  // scope), where no declaration stands for them (`function (require) {`).
  let moduleLike = false
  const commonjs = []
  const declaredFrom = (name, from, top = moduleLike) => {
    for (let at = from; at !== -1; at = scopes[at].parent) if ((at !== 0 || top) && scopes[at].names.has(name)) return true
    return false
  }
  // Each `var`, `let` or `const` under way: the depth of its declarators,
  // whether in their names (before `=`, patterns too) rather than what they
  // are set to, whether exported. Each `(…)` under way but a statement's,
  // and the names in it: parameters, if `=>` or `{` follows. The depths
  // whose `=` began a default (`{ x = a }`), until their next `,`: no
  // names declared there.
  const declarations = [], defaulted = new Set(), groups = []
  const inDefault = (from, to = opens.length) => {
    for (const depth of defaulted) if (depth >= from && depth <= to) return true
    return false
  }
  const inComputed = from => {
    for (let depth = from; depth < opens.length; depth++) if (opens[depth] === 'computed') return true
    return false
  }
  // `exporting` between `export` and its name; `naming` before a name
  // declared as `function a` is, `named` by which word and whether as a
  // statement; `extending` the depths of each `extends` whose class body is
  // the next `{` there, a class in another's `extends` on top
  // (`extends mixin(class extends B {}) {`), as a class or a function there
  // is, its body that `{` (`extends class {} {`, `extends function () {} {`).
  // `dynamic` once `eval` or a `with (…)` can read a name by its spelling:
  // renaming one then changes what runs; so once a name is escaped
  // (`\u0065val`), the one `\` code holds outside strings. So too where a
  // decorator (`@dec a() {}`), whatever it reads, comes before a key; and
  // where a line breaks after `await` (`awaited`) outside a module, a name
  // there or an operator, as its function is `async` or not (`a => await⏎a()`),
  // unknown here. `parameters` where a `(…)` would
  // be a function's parameters (after `function`, its name, a method's key
  // or `catch`), not a call's arguments.
  // `labeled` between a label and its `:`, after which a statement starts.
  const extending = []
  let at = 0, awaited = false, casing = -1, dynamic = false, exporting = false, keyPlace = false, labeled = false, last = null, modifier = null, naming = false, parameters = false
  let named = { statement: true, word: null }
  const keep = segment => {
    key.push(segment)
    for (let i = segment.indexOf('\n'); i !== -1; i = segment.indexOf('\n', i + 1)) names.push([])
  }
  // What lies between, as read (`raw`) and, its comments set aside but their
  // line breaks, as code (`segment`).
  const between = (raw, segment = raw) => {
    keep(raw)
    program.push(segment)
    // Nor where a fragment opens, `<>` being JSX alone, whatever it holds.
    if (segment.includes('\\') || segment.includes('@') || segment.includes('<>')) dynamic = true
    // A line break ends these statements, whatever follows (`continue⏎+a`),
    // a `/` after it starting a value.
    const restricted = segment.includes('\n') && RESTRICTED.has(last)
    if (restricted) last = ';'
    // A line break no operator spans may end a statement, as `;` does, or a
    // class field: even one alone between two names (`let x⏎f()`).
    const line = segment.lastIndexOf('\n')
    const after = segment.slice(line + 1).trimStart(), before = segment.slice(0, line).trimEnd()
    // A `++` or `--` either side of it is the line's own (`a++⏎b`, `x⏎++a`);
    // after a declared name with no value (`let x⏎+a`), only `=` or `,` goes on.
    const bare = declarations.at(-1)?.binding && declarations.at(-1).depth === opens.length
    // A line beginning with `(`, `[` or a template goes on the line before
    // (`fn⏎(a)`, a call), as does one beginning with a `/` that divides (`x⏎/a/g`),
    // `in` or `instanceof`.
    INFIX.lastIndex = at + raw.length
    const leads = after === '' && (/[([`]/u.test(text[at + raw.length] ?? '') || INFIX.test(text)
      || (text[at + raw.length] === '/' && divides(segment.trimEnd().at(-1) ?? last, segment)))
    // Nor after a word a value must follow (`typeof⏎a`), but `return` and the like.
    const value = BEFORE_VALUE.has(last) && (last !== 'of' || inHead())
    if (line !== -1 && before === '' && last === 'await') awaited = true
    const ends = !(line !== -1 && value && !restricted) && (restricted || (line !== -1 && (bare ? !/[,=]$/u.test(before) && !/^[,=]/u.test(after)
      : !CONTINUES.test(before) && !/^(?!\+\+|--)[,=+\-*/%&|^<>?:.)\]}]/u.test(after) && !leads)))
    if (ends && declarations.at(-1)?.depth === opens.length) declarations.pop()
    // Ending a declared name, the line break ends its statement: `let a⏎/a/`.
    if (ends && bare) last = ';'
    // A concise arrow's body ends where its line, a `,`, a `;` or a
    // conditional's `:` does (`x ? a => a : a()`), not its own conditional's
    // (`a => c ? a : a`).
    if (ends) endArrows(opens.length)
    for (const [mark] of segment.matchAll(ARROW_ENDS)) {
      if (mark !== '?') endArrows(opens.length, mark === ':')
      else if (arrows.at(-1)?.depth === opens.length) arrows.at(-1).conditionals++
    }
    if (ends || segment.includes(';')) endLoops(opens.length, at + raw.length)
    let end = segment.length
    while (end > 0 && segment.codePointAt(end - 1) <= 32) end--
    if (end === 0) return
    last = segment[end - 1] === ':' && labeled ? ';' : segment[end - 1]
    labeled = false
    if (casing === opens.length && segment.includes(':')) {
      casing = -1
      if (last === ':') last = ';'
    }
    const declaration = declarations.at(-1)
    const next = segment.lastIndexOf(','), set = segment.search(/(?<![=!<>])=(?![=>])[^=]*$/u)
    if (declaration?.depth === opens.length && set !== next) declaration.binding = next > set
    else if (set > next) defaulted.add(opens.length)
    else if (next > set || segment.includes(';')) defaulted.delete(opens.length)
    if (segment.includes(';')) while (declarations.length > 0 && opens.length <= declarations.at(-1).depth) declarations.pop()
    // A generator's `*` or a private name's `#` (`static #m() {}`, `*#m() {}`)
    // leaves its name in its key place, or to be declared.
    const marked = /(?:\*\s*)?#?$/u.exec(segment.slice(0, end))[0].length
    if (marked > 0 && segment.slice(0, end - marked).trim() === '') return
    exporting = naming = false
    // A number key (`1() {}`), as a key's name.
    parameters = opens.at(-1) === 'object' && /(?:^|[,;])\s*\.?\d[\w.]*\s*$/u.test(segment)
    const place = marked > 0 ? segment.slice(0, end - marked).trimEnd().at(-1) : last
    keyPlace = (place === ',' || place === ';') && opens.at(-1) === 'object'
  }
  // A template's text, kept as a string is: where it opens a substitution
  // (`${`), code follows, a value starting there as after `(`.
  const template = token => {
    keep(token)
    const open = token.endsWith('${')
    program.push(`""${token.replaceAll(/[^\n]/gu, '')}${open ? '{' : ''}`)
    if (open) opens.push('substitution')
    last = open ? '(' : '"'
    exporting = keyPlace = naming = parameters = false
  }
  // Ending its line, a value ends its class field: the next name is a key,
  // a private one's too (`x = 1⏎#m() {}`).
  const lineEnd = segment => {
    const line = segment.lastIndexOf('\n')
    if (line !== -1 && opens.at(-1) === 'object' && /^#?$/u.test(segment.slice(line + 1).trim()) && !CONTINUES.test(segment.slice(0, line).trimEnd())) keyPlace = true
  }
  for (READ.lastIndex = 0; ;) {
    // A comment lies between what is read as spaces do, its line breaks
    // ending statements as theirs do (`let x /*⏎*/ f()`).
    let match = READ.exec(text)
    while (match && /^(?:#!|\/[/*]|<!--|-->)/u.test(match[0])) match = READ.exec(text)
    const gap = text.slice(at, match?.index ?? text.length)
    const code = gap.replaceAll(COMMENT, comment => comment.replaceAll(/[^\n]/gu, '') || ' ')
    between(gap, code)
    lineEnd(code)
    if (!match) break
    const first = match[0][0], token = match[0]
    // A key's modifier just before (`static {`), comments or spaces between.
    const modified = modifier
    modifier = null
    if (first === '/' && token[1] !== '/' && token[1] !== '*' && divides(last, code)) {
      // A division: the `/` is an operator, and what follows is read again.
      at = match.index
      READ.lastIndex = at + 1
      between('/')
      at++
      continue
    }
    at = READ.lastIndex
    if (first === '`') template(token)
    else if (first === '"' || first === "'" || first === '/') {
      keep(token)
      program.push(`""${token.replaceAll(/[^\n]/gu, '')}`)
      // After a `}` a `/` may divide what a function, a class or an object
      // was (`function(){} / a / y`), and after `await` or `yield`, names
      // outside an `async` function or a generator (`await / a / y`): unknown
      // here, read as a regular expression, one holding what may be a name
      // or an escaped one turns renames off.
      if (first === '/' && (last === '}' || last === 'await' || last === 'yield') && /[\p{ID_Start}_$\\]/u.test(token)) dynamic = true
      // A module's name ends its `import` or `export … from`, as `;` does.
      last = first !== '/' && (last === 'import' || last === 'from') ? ';' : '"'
      // A key's (`"m"() {}`), a `(…)` after it is a method's parameters.
      parameters = keyPlace
      exporting = keyPlace = naming = false
    } else if (first === '}' && opens.at(-1) === 'substitution') {
      // A substitution's end, its template's text going on.
      opens.pop()
      endArrows(opens.length + 1)
      endLoops(opens.length + 1, at)
      TEMPLATE.lastIndex = match.index + 1
      at = READ.lastIndex = TEMPLATE.test(text) ? TEMPLATE.lastIndex : text.length
      template(text.slice(match.index, at))
      for (const depth of defaulted) if (depth > opens.length) defaulted.delete(depth)
      while (declarations.length > 0 && opens.length < declarations.at(-1).depth) declarations.pop()
    } else if (first === '(' || first === '[' || first === '{') {
      key.push(token)
      program.push(token)
      // A class's body after its `extends`, whatever that ends with: `extends mixin(Base) {`.
      const body = first === '{' && extending.at(-1)?.depth === opens.length ? extending.pop() : null
      const heritage = body !== null && body.word !== 'function'
      const own = classes.at(-1)?.depth === opens.length && first === '{' && classes.at(-1).marker === body ? classes.pop() : null
      if (own) classBodies.push({ depth: opens.length + 1, scoped: own.scoped })
      // An arrow's body after its `=>`, an object after a `>` (`0 > { a }`).
      // A class's `static {`, a block whose `var`s are its own.
      const initializer = first === '{' && keyPlace && modified === 'static'
      const block = first === '{' && !heritage && (last === null || ');{}'.includes(last) || BEFORE_BLOCK.has(last)
        || (last === '>' && code.trimEnd().endsWith('=>')) || initializer)
      // A `[…]` in a key's place is a computed key, its names references: `{ [a]: x }`.
      const open = first === '{' ? last === 'export' ? 'export' : block ? 'block' : 'object'
        : first === '(' && CONTROL.has(last) ? 'control' : first === '[' && keyPlace ? 'computed' : first
      if (open === 'control' && last === 'for') {
        enter()
        loops.push({ body: false, depth: opens.length, scope })
      }
      opens.push(open)
      // A function expression's own name its `(…)`'s, not a call's in it (`function a(p = f()) {`).
      if (open === '(') {
        groups.push({ asides: setAside.length, caught: last === 'catch', depth: opens.length, names: [], parameters, scopes: scopes.length, self })
        self = null
      }
      // A function's body is its scope, a `catch`'s not.
      if (open === 'block') enter(pending ?? [], { fn: (pending !== null && !pendingGroup?.caught) || initializer, group: pendingGroup })
      if (first === '{') pending = pendingGroup = null
      last = first
      keyPlace = first === '{' && !block && open !== 'export'
      exporting = naming = parameters = false
    } else if (first === ')' || first === ']' || first === '}') {
      key.push(token)
      program.push(token)
      const open = opens.pop()
      endArrows(opens.length + 1)
      if (open === 'block') leave()
      if (classBodies.at(-1)?.depth === opens.length + 1 && classBodies.pop().scoped) leave()
      BRACED.lastIndex = at
      if (open === 'control' && loops.at(-1)?.depth === opens.length && !loops.at(-1).body) Object.assign(loops.at(-1), { body: true, braced: BRACED.test(text), doing: 0 })
      else endLoops(first === '}' ? opens.length : opens.length + 1, at)
      if (open === '(') {
        const group = groups.pop()
        BODY.lastIndex = ARROW.lastIndex = at
        ARROW_BODY.lastIndex = at
        if (ARROW_BODY.test(text) || (group.parameters && BODY.test(text))) {
          pending = group.self ? [...group.names, group.self] : group.names
          pendingGroup = group
        } else if (ARROW.test(text)) {
          enter(group.names, { fn: true, group })
          arrows.push({ conditionals: 0, depth: opens.length })
        }
      }
      // After a statement's condition, as after `;`, a statement starts.
      last = open === 'control' ? ';' : first
      keyPlace = first === '}' && opens.at(-1) === 'object'
      // A computed key's `]` (`[k]() {}`), as a key's name.
      parameters = open === 'computed'
      exporting = naming = false
      for (const depth of defaulted) if (depth > opens.length) defaulted.delete(depth)
      while (declarations.length > 0 && opens.length < declarations.at(-1).depth) declarations.pop()
    } else {
      const declaration = declarations.at(-1), group = groups.at(-1)
      const binding = declaration?.binding && opens.length >= declaration.depth && !inDefault(declaration.depth + 1)
        && !inComputed(declaration.depth)
      // In an `export { … }`, a local name renamed `as` another is no name
      // exported, but a re-export's are all another module's (`export { a } from "m"`).
      AS.lastIndex = EXPORT_FROM.lastIndex = at
      const reexport = opens.at(-1) === 'export' && EXPORT_FROM.test(text)
      const exported = (opens.at(-1) === 'export' && (reexport || last === 'as' || !AS.test(text))) || (exporting && !KEYWORDS.has(token)) || (binding && declaration.exported)
      // A property: `.` before it, spaces or a comment between (`a . b`), or `:`
      // after it in a key's place, spaces or a comment between too (`{ a : x }`),
      // not a conditional's (`c?a:b`) nor a `case`'s (`case a:`); a private one,
      // `#` before it (`this.#a`); or a label, where a statement starts (`a: {`)
      // or after `break` or `continue` (`break a`), which a line break still ends.
      const jump = last === 'break' || last === 'continue'
      KEYED.lastIndex = at
      const colon = KEYED.test(text)
      const keyed = keyPlace && colon, label = colon && !keyPlace && statement(last)
      // A spread's or a rest's name, after `...`, is none (`{ ...a }`).
      const member = last === '.' && !code.trimEnd().endsWith('...')
      const property = member || last === '#' || keyed || label || jump
      // A label's block is a block.
      if (label) labeled = true
      program.push(token)
      let aside = null
      if (token.length > RENAMED_MAX_LENGTH || KEYWORDS.has(token) || keyPlace || exported || property) key.push(token)
      else {
        setAside.push(aside = [key.length, names.length - 1, token, scope])
        key.push(NAMELESS)
      }
      // An object's shorthand property is a name read too (`{ a }`), its key
      // kept: not a pattern's declaring it, nor a class's field.
      SHORTHAND.lastIndex = at
      if (keyPlace && !binding && token.length <= RENAMED_MAX_LENGTH && !KEYWORDS.has(token) && opens.at(-1) === 'object'
        && classBodies.at(-1)?.depth !== opens.length && SHORTHAND.test(text)) setAside.push([key.length - 1, names.length - 1, token, scope])
      // So is a name an `export { … }` exports as it is (`export { a }`), but
      // not a re-export's.
      if (exported && opens.at(-1) === 'export' && !reexport && last !== 'as' && token !== 'as' && token.length <= RENAMED_MAX_LENGTH
        && !KEYWORDS.has(token)) setAside.push([key.length - 1, names.length - 1, token, scope])
      ARROW_BODY.lastIndex = ARROW.lastIndex = at
      // A pattern's key (`{ a: x }`) names what is read, not what is bound.
      const read = keyed || label || member || last === '#'
      // A function or a class expression's name is its own body's.
      if (!read && naming && !KEYWORDS.has(token) && !named.statement) {
        if (named.word === 'function') self = { aside, name: token }
        else if (named.word === 'class' && classes.at(-1)?.depth === opens.length) {
          enter([{ aside, name: token }])
          classes.at(-1).scoped = true
        }
      } else if (!read && (naming || binding)) {
        declare(token, binding && declaration.hoisted)
        if (naming && named.word === 'function' && !scopes[scope].fn) blockFunctions.push([token, scope])
      }
      else if (!read && ARROW_BODY.test(text)) {
        pending = [{ aside, name: token }]
        pendingGroup = null
      }
      else if (!read && ARROW.test(text)) {
        enter([{ aside, name: token }])
        arrows.push({ conditionals: 0, depth: opens.length })
      }
      if (!read && group && !inDefault(group.depth) && !inComputed(group.depth)) group.names.push({ aside, name: token })
      // A key or a property is no keyword: `{ const: a }`, `x.var`.
      const word = keyPlace || property ? null : token
      if (word === 'eval' || word === 'with') dynamic = true
      parameters = keyPlace || word === 'function' || word === 'catch' || (naming && named.word === 'function')
      const within = extending.at(-1)?.depth === opens.length ? extending.at(-1) : null
      if (word === 'extends' && within?.word !== 'class') extending.push({ depth: opens.length, word })
      else if ((word === 'class' || word === 'function') && within) extending.push({ depth: opens.length, word })
      else if (word === 'extends') within.word = word
      if (word === 'class') classes.push({ depth: opens.length, marker: within ? extending.at(-1) : null, scoped: false })
      if (word === 'do' && loops.at(-1)?.body && loops.at(-1).depth === opens.length) loops.at(-1).doing++
      // A `case`'s or a `default`'s `:` begins a statement (`case 1: {`).
      if ((word === 'case' || (word === 'default' && last !== 'export')) && opens.at(-1) === 'block') casing = opens.length
      if (word === 'extends' && classes.at(-1)?.depth === opens.length && classes.at(-1).marker === null) classes.at(-1).marker = extending.at(-1)
      if (binding && (word === 'in' || word === 'of')) declaration.binding = false
      LET.lastIndex = at
      if (word === 'const' || word === 'var' || (word === 'let' && LET.test(text))) declarations.push({ binding: true, depth: opens.length, exported: exporting, hoisted: word === 'var' })
      IMPORT_CALL.lastIndex = at
      if (word === 'export' || (word === 'import' && !IMPORT_CALL.test(text))) moduleLike = true
      const after = COMMONJS.get(word)
      if (after) after.lastIndex = at
      if (after?.test(text)) commonjs.push([word, scope])
      if (word === 'export') exporting = true
      else if (!DECLARES.has(word)) exporting = false
      if (word === 'async') named = { statement: statement(last), word: null }
      if (word === 'function' || word === 'class') named = { statement: last === 'async' ? named.statement : statement(last), word }
      else if (NAMING.has(word)) named = { statement: true, word }
      naming = NAMING.has(word) || (naming && word === 'async')
      // `for await (` is a `for`'s condition still.
      if (keyPlace && MODIFIERS.has(token)) modifier = token
      if (!(keyPlace && MODIFIERS.has(token)) && !(token === 'await' && last === 'for')) {
        last = jump ? last : word ?? '_'
        keyPlace = false
      }
    }
  }
  // Read past its block in its function, outside a module, a function declared
  // in a block may be the function's or another, as the code is strict or not
  // (`function f() { if (x) { function a() {} } return a }`): renames go.
  const within = (from, of) => {
    for (let step = from; step !== -1; step = scopes[step].parent) if (step === of) return true
    return false
  }
  const fnOf = step => scopes[step].fn ? step : fnOf(scopes[step].parent)
  if (!moduleLike && setAside.some(([, , name, from]) => blockFunctions.some(([own, block]) => own === name && !within(from, block) && within(from, fnOf(block))))) dynamic = true
  if (awaited && !moduleLike) dynamic = true
  if (commonjs.some(([name, from]) => !declaredFrom(name, from, true))) moduleLike = true
  // A name no declaration in scope stands for is a global's, kept.
  for (const [piece, line, name, from] of setAside) {
    if (declaredFrom(name, from)) names[line].push(name)
    else key[piece] = name
  }
  return { dynamic, jsx: JSX.test(program.join('')), key: key.join(''), names }
}

// The change blocks between two texts' lines with names renamed alike left
// out, and the removed lines so left out. Lines pair up as they are with
// their names set aside, then every pair, unchanged ones too, tells which
// name became which; a pair whose names differ is left out only when each
// of its names stands for the one other throughout, neither side's ever
// standing for a second. Any other (a name renamed two ways, or two names
// renamed to one, as a line's `a` → `b` beside unchanged lines naming both)
// is a change.
function renameBlocks(before, after, a, b, ignoreWhitespace) {
  const na = nameless(before), nb = nameless(after)
  if (na.dynamic || nb.dynamic || na.jsx || nb.jsx) return { blocks: changeBlocks(before, after, ignoreWhitespace), renamed: new Set() }
  const found = changeBlocks(na.key, nb.key, ignoreWhitespace)
  const pairs = []
  let i = 0, j = 0
  for (const block of [...found, { a0: a.length, a1: a.length, b0: b.length, b1: b.length }]) {
    while (i < block.a0) pairs.push([i++, j++])
    i = block.a1
    j = block.b1
  }
  const backward = new Map(), forward = new Map()
  const link = (map, from, to) => { if (!map.has(from)) map.set(from, new Set()); map.get(from).add(to) }
  // A pair reading names on one side its other does not (`{ a }` declared on
  // one alone) is a change, its names linked to none.
  const even = (pa, pb) => na.names[pa].length === nb.names[pb].length
  for (const [pa, pb] of pairs) if (even(pa, pb)) na.names[pa].forEach((name, k) => { link(forward, name, nb.names[pb][k]); link(backward, nb.names[pb][k], name) })
  const sole = (from, to) => forward.get(from).size === 1 && backward.get(to).size === 1
  const blocks = [], renamed = new Set()
  const add = block => {
    const last = blocks.at(-1)
    if (last && last.a1 === block.a0 && last.b1 === block.b0) { last.a1 = block.a1; last.b1 = block.b1 } else blocks.push({ ...block })
  }
  let next = 0
  for (const [pa, pb] of pairs) {
    while (next < found.length && found[next].a0 <= pa) add(found[next++])
    const names = na.names[pa], others = nb.names[pb]
    if (!even(pa, pb)) add({ a0: pa, a1: pa + 1, b0: pb, b1: pb + 1 })
    else if (names.every((name, k) => name === others[k])) continue
    else if (names.every((name, k) => sole(name, others[k]))) renamed.add(pa)
    else add({ a0: pa, a1: pa + 1, b0: pb, b1: pb + 1 })
  }
  while (next < found.length) add(found[next++])
  return { blocks, renamed }
}

// A tag where a value starts (`(<a />`, `if (x) <b />`, `x + <i />`, `...<a />`, `return <i>`,
// `yield <p>`, not after `<` but a spaced one (`x < <a />`), as `a<<b>>>0` has it; a fragment's `<>` before
// what it holds, an entity too (`<>&amp;`), not `[&<>"']`'s): JSX, whose
// tags are no bindings, so its file's names are not set aside. After the
// words a regular expression may follow, BEFORE_VALUE (`extends <a />`).
// Looked for in the code alone (nameless's `program`): HTML in a string or a
// template (`"</a><select id='"`) is none.
const JSX = new RegExp(String.raw`(?:^|\.\.\.|<[ \t]|[()=,:?&|!{};>[+\-*/%^~]|\b(?:${[...BEFORE_VALUE].join('|')}))[ \t]*<(?:\/?[\p{ID_Start}_$][-\p{ID_Continue}$.:\u200C\u200D]*(?:\s|\/?>)|>(?=[\s<{\p{L}]|&[\w#]+;))`, 'mu')

// The change blocks between two texts' lines with the lines differing only in
// short names renamed alike throughout left out (renameBlocks), as a minifier
// renames them from one build to the next, and the removed lines so left out
// (`renamed`), in order. `ignoreWhitespace` is diff -w.
export function renameDiff(before, after, { ignoreWhitespace = false } = {}) {
  const { blocks, renamed } = renameBlocks(before, after, textLines(before), textLines(after), ignoreWhitespace)
  return { blocks, renamed: [...renamed].toSorted((x, y) => x - y) }
}
