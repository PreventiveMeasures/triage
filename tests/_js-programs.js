// Small JavaScript programs made at random, for testing what reads names
// (rename-map.js): names few and reused, so that scopes shadow and capture,
// across functions, closures, blocks, loops, `catch`, `switch`, parameter
// defaults and `typeof` of names that may be no variable's. Each logs what it
// reads, so two programs run alike where their logs are alike. Seeded: one
// seed, one program.
import vm from 'node:vm'

// A random number in [0, 1) for each call, from a seed (mulberry32).
export function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

// A program's text, a CommonJS module's: each name declared where
// JavaScript allows it, so that the program compiles, and read where it is
// declared.
export function program(seed, statements = 12) {
  const next = random(seed)
  const pick = list => list[Math.floor(next() * list.length)]
  const chance = p => next() < p
  const lines = []
  // Scopes innermost last, each its names and whether a function's.
  const scopes = [{ names: new Map(), fn: true }]
  const visible = kinds => {
    const seen = new Map()
    for (const scope of scopes) for (const [name, kind] of scope.names) seen.set(name, kind)
    return [...seen].filter(([, kind]) => !kinds || kinds.includes(kind)).map(([name]) => name)
  }
  // Functions callable from here: declared before, none around this point, so calls never recurse.
  const callable = []
  const around = []
  // Whether `name` may be declared here as `kind`: any but a `var` once in its
  // scope, and a `var` past no other of its name up to its function, as it is
  // that function's.
  // No `var` shares a function's name, nor a function a `var`'s: the value
  // read would be either, by when, and a function is never one here.
  const LEXICAL = new Set(['let', 'const', 'const-fn', 'block-fn', 'fn'])
  const free = (name, kind) => {
    // A function declared names it throughout its scope, before it too: none in sight takes it.
    if (kind === 'fn') return !visible().includes(name)
    if (kind !== 'var') return !scopes.at(-1).names.has(name)
    for (let k = scopes.length - 1; k >= 0; k--) {
      if (LEXICAL.has(scopes[k].names.get(name))) return false
      if (scopes[k].fn) break
    }
    return true
  }
  // A `var` is its function's, and read as declared in every scope up to it.
  const declare = (name, kind) => {
    if (kind !== 'var') { scopes.at(-1).names.set(name, kind === 'fn' && !scopes.at(-1).fn ? 'block-fn' : kind); return }
    for (let k = scopes.length - 1; k >= 0; k--) {
      if (!scopes[k].names.has(name)) scopes[k].names.set(name, 'var')
      if (scopes[k].fn) break
    }
  }
  // A name `kind` may be declared as here, or null where none of a few tried may.
  const fresh = kind => {
    for (let tries = 0; tries < 5; tries++) {
      const name = pick(NAMES)
      if (free(name, kind)) return name
    }
    return null
  }
  // Values never functions: one added to a string is its source, names and all.
  const expression = (depth = 0) => {
    const names = visible(['let', 'const', 'var', 'param', 'catch'])
    const roll = next()
    if (depth < 2 && roll < 0.2) return `(${expression(depth + 1)} + ${expression(depth + 1)})`
    if (depth < 2 && roll < 0.35) {
      const fns = callable.filter(name => visible(['fn', 'block-fn', 'const-fn']).includes(name) && !around.includes(name))
      if (fns.length > 0) return `${pick(fns)}(${expression(depth + 1)})`
    }
    if (roll < 0.45) return `typeof ${pick(NAMES)}`
    if (roll < 0.8 && names.length > 0) return pick(names)
    return String(Math.floor(next() * 10))
  }
  const indent = () => '  '.repeat(scopes.length - 1)
  const open = (line, fn = false) => { lines.push(indent() + line); scopes.push({ names: new Map(), fn }) }
  const close = (line = '}') => { scopes.pop(); lines.push(indent() + line) }
  const body = (depth, count) => { for (let i = 0; i < count; i++) statement(depth + 1) }
  function statement(depth) {
    const roll = next()
    const name = pick(NAMES)
    if (depth > 2 || roll < 0.25) {
      const kind = pick(['let', 'const', 'var'])
      const declared = chance(0.5) ? fresh(kind) : null
      if (declared === null) lines.push(`${indent()}log(${expression()});`)
      else {
        lines.push(`${indent()}${kind} ${declared} = ${expression()};`)
        declare(declared, kind)
      }
      return
    }
    if (roll < 0.4 && free(name, 'fn')) {
      const params = Array.from({ length: Math.floor(next() * 3) }, () => pick(NAMES)).filter((param, i, all) => all.indexOf(param) === i)
      const list = params.map((param, i) => (i === params.length - 1 && chance(0.3) ? `${param} = ${expression()}` : param)).join(', ')
      declare(name, 'fn')
      around.push(name)
      open(`function ${name}(${list}) {`, true)
      for (const param of params) declare(param, 'param')
      body(depth, 1 + Math.floor(next() * 3))
      lines.push(`${indent()}return ${expression()};`)
      close()
      around.pop()
      callable.push(name)
      lines.push(`${indent()}log(${name}(${expression()}));`)
      return
    }
    if (roll < 0.5 && free(name, 'const')) {
      // Declared first: its body reads its own name as the function it is.
      declare(name, 'const-fn')
      lines.push(`${indent()}const ${name} = ${chance(0.5) ? 'x' : '(x, y)'} => ${expression()};`)
      callable.push(name)
      return
    }
    if (roll < 0.6) { open('{'); body(depth, 1 + Math.floor(next() * 3)); close(); return }
    if (roll < 0.7) {
      open(`if (${expression()}) {`)
      body(depth, 1 + Math.floor(next() * 2))
      close('} else {')
      scopes.push({ names: new Map(), fn: false })
      body(depth, 1 + Math.floor(next() * 2))
      close()
      return
    }
    if (roll < 0.8) {
      open('try {')
      body(depth, 1 + Math.floor(next() * 2))
      lines.push(`${indent()}throw ${expression()};`)
      close(`} catch (${name}) {`)
      scopes.push({ names: new Map([[name, 'catch']]), fn: false })
      body(depth, 1 + Math.floor(next() * 2))
      close()
      return
    }
    if (roll < 0.9) {
      open(`switch (${expression()}) {`)
      lines.push(`${indent()}case 1:`)
      body(depth, 1 + Math.floor(next() * 2))
      lines.push(`${indent()}default:`)
      body(depth, 1)
      close()
      return
    }
    open(`for (let ${name} = 0; ${name} < 2; ${name}++) {`)
    declare(name, 'let')
    body(depth, 1 + Math.floor(next() * 2))
    close()
  }
  for (let i = 0; i < statements; i++) statement(0)
  // Strict, as outside strict code a function declared in a block is no block's alone (rename-map.js refuses those).
  return ['"use strict";', ...lines].map(line => `${line}\n`).join('')
}

// An error's message without the names it quotes, which renaming changes as
// it does a function's source: `Cannot access 'b' before initialization`.
const unnamed = text => text.replaceAll(/Cannot access '[^']*'/gu, 'Cannot access _').replaceAll(/[\w$.]+ is not (?:defined|a function)/gu, '_ is not $&')
  .replaceAll(/_ is not [\w$.]+ is not /gu, '_ is not ')

// What a program logs, as a CommonJS module's body, and how it ends: a value
// read, `fn` for a function, an error by its kind and message (each without
// the names in it, as renaming changes those), and the kind of what it threw,
// if it did.
export function run(code) {
  const logged = []
  const log = value => {
    if (typeof value === 'function') logged.push('fn')
    else if (typeof value === 'string') logged.push(unnamed(value))
    else if (value && typeof value === 'object') logged.push(`${value.constructor.name}: ${unnamed(String(value.message))}`)
    else logged.push(value)
  }
  try {
    vm.runInNewContext(`(function (module, exports, log) {\n${code}\n})`, {}, { timeout: 2000 })({ exports: {} }, {}, log)
  } catch (err) {
    logged.push(`threw ${typeof err === 'object' && err ? err.constructor.name : String(err)}`)
  }
  return logged
}

// Whether V8 compiles a program as a CommonJS module's body.
export function compiles(code) {
  try {
    void new vm.Script(`(function (module, exports, log) {\n${code}\n})`)
    return true
  } catch { return false }
}
