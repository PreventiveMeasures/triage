// The focus view's Code panel remembers where it has been. This is
// that memory as pure stack algebra — no state, no DOM — because the
// two callers sit at opposite ends of the app and neither is a good
// place to reason about it: focus-code.js reads the history during
// render(), where writing is not allowed, and events.js writes it from
// a click, where reading the render's view of things is awkward.
//
// A POSITION is `{ integrity, file, range }`: one file out of one
// bundle, and the lines the link that opened it pointed at.
//
// The stack always starts at the finding's own file — the panel was
// already showing something before the reader followed anything — so
// entry 0 is the BASE, and an empty stack means nothing has been
// followed yet. That is also what the panel's back / forward pair is
// gated on: nothing followed, nothing to offer.

function samePos(a, b) {
  return Boolean(a) && Boolean(b)
    && a.integrity === b.integrity
    && a.file === b.file
    && (a.range?.start ?? null) === (b.range?.start ?? null)
    && (a.range?.end ?? null) === (b.range?.end ?? null)
}

const NONE = []

// What the panel should draw, given a stored stack and the finding
// currently on screen.
//
// A stack whose entry 0 isn't this finding's own file belongs to some
// finding the reader has since left — the focus change that should
// have cleared it didn't reach here (a tab switch inside a group
// changes the panel's file without going through it). Rather than
// repair it from a render, which cannot write, this simply doesn't use
// it: the panel falls back to the base and the next thing that MOVES
// the panel rewrites the stack from scratch.
export function historyFor(stack, at, base) {
  if (!base) return null
  if (!Array.isArray(stack) || stack.length === 0 || !samePos(stack[0], base)) {
    return { stack: NONE, at: 0, pos: base }
  }
  const clamped = Math.min(Math.max(at, 0), stack.length - 1)
  return { stack, at: clamped, pos: stack[clamped] }
}

// Follow a link to `pos`.
//
// Everything after the current entry goes. The reader was somewhere,
// went back, and has now gone somewhere else — the branch they left is
// no longer reachable, which is what a back/forward history is and
// what the buttons have to keep telling the truth about:
//
//   [base … here … dropped]  →  [base … here … pos]
//
// The first push seeds TWO entries, because the panel was already
// showing the finding's own file: without it there would be nothing to
// go Back to from the first link ever followed.
//
// Following a link to where the panel already is changes nothing but
// the index — stacking a duplicate would light up a Back button that
// appears to do nothing.
export function pushed(stack, at, base, pos) {
  const kept = Array.isArray(stack) && stack.length > 0
    ? stack.slice(0, Math.min(Math.max(at, 0), stack.length - 1) + 1)
    : [base]
  if (samePos(kept.at(-1), pos)) return { stack: kept, at: kept.length - 1 }
  return { stack: [...kept, pos], at: kept.length }
}

// Back (-1) / forward (+1). Clamped, never wrapped: the ends of a
// history are ends, and a Back that teleports you to the newest file
// is not a thing any reader is asking for.
export function stepped(stack, at, direction) {
  if (!Array.isArray(stack) || stack.length === 0) return 0
  return Math.min(Math.max(at + direction, 0), stack.length - 1)
}
