// Where the focus view's Code panel has been, as pure stack algebra: read
// during render() (focus-code.js), which may not write, and written from a
// click (events.js). A position is `{ integrity, file, range }`. Entry 0 is
// the base, the finding's own file, shown before anything was followed; an
// empty stack means nothing was, and offers no back / forward.

// Same file, same lines marked: following a reference there goes nowhere.
// The evidence list asks it of every row, to mark the one shown.
export function samePos(a, b) {
  return Boolean(a) && Boolean(b)
    && a.integrity === b.integrity
    && a.file === b.file
    && (a.range?.start ?? null) === (b.range?.start ?? null)
    && (a.range?.end ?? null) === (b.range?.end ?? null)
}

const NONE = []

// What the panel draws for the finding on screen. A stack not based on its
// file is another finding's (a tab switch moves the file without clearing
// it): unused, not repaired, as a render can't write; the next move
// rewrites it.
export function historyFor(stack, at, base) {
  if (!base) return null
  if (!Array.isArray(stack) || stack.length === 0 || !samePos(stack[0], base)) {
    return { stack: NONE, at: 0, pos: base }
  }
  const clamped = Math.min(Math.max(at, 0), stack.length - 1)
  return { stack, at: clamped, pos: stack[clamped] }
}

// A reference to `pos` followed, from historyFor's history: null where the
// panel shows it already (as most reports' first evidence row restates the
// finding), nothing recorded; else the entries after the current one
// dropped, as a back/forward history does, the base seeded on the first.
//
//   [base … here … dropped]  →  [base … here … pos]
export function pushed({ stack, at, base }, pos) {
  const current = stack.length > 0 ? stack[at] : base
  if (samePos(current, pos)) return null
  const kept = stack.length > 0 ? stack.slice(0, at + 1) : [base]
  return { stack: [...kept, pos], at: kept.length }
}

// Back (-1) / forward (+1), clamped, never wrapped.
export function stepped(stack, at, direction) {
  if (!Array.isArray(stack) || stack.length === 0) return 0
  return Math.min(Math.max(at + direction, 0), stack.length - 1)
}
