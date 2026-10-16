import { cut, quoted } from './excerpt.js'

// `where` is the place in the lockfile a refusal is about, as a property
// path from its top -- `packages["q@1.5.1"].resolution` -- or undefined for
// the file as a whole; the message leads with it.
export class LockfileError extends Error {
  constructor(detail, where) {
    super(where === undefined ? detail : `${where}: ${detail}`)
    this.name = 'LockfileError'
    this.where = where
  }
}

// A refusal thrown, where an expression needs one.
export const raise = (detail, where) => {
  throw new LockfileError(detail, where)
}

// What `run` returns, or, where it throws, what `otherwise(error)` does.
export function attempt(run, otherwise) {
  try {
    return run()
  } catch (error) {
    return otherwise(error)
  }
}

// A piece of the lockfile for a message, as excerpt.js shows one: at most
// 200 code units, and an ellipsis, U+2026, within the quote where cut.
export function quote(text) {
  const short = cut(text, 200)
  return quoted(short === text ? text : `${short}\u2026`)
}

// One step down a property path: `.key` where the key reads as one, `['k']`
// where it does not.
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u
export function at(where, key) {
  if (!IDENTIFIER.test(key)) return `${where}[${quote(key)}]`
  return where === '' ? key : `${where}.${key}`
}
