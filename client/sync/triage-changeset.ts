// Pure triage-changeset algebra, split out of triage-sync.ts. Holds the
// triage data model (a per-finding entry, the id→entry state map, and
// the changeset / conflict shapes) plus the side-effect-free operations
// over them: diff, apply, equality, and the three-way conflict scan. No
// module state, no `state.*`, no I/O — safe to unit-test in isolation.

import type { TriageEntry } from './host.ts'

export type ConflictProperty = 'color' | 'triage' | 'comment' | 'fix'

export type Conflict = {
  id: string
  property: ConflictProperty
  local: string
  imported: string
}

// `TriageEntry` (the per-finding-id triage value carried on the wire
// and in baseState) is defined in `../state.ts` — the same shape
// `state.triage` stores live — and re-exported through `host.ts`.
export type TriageStateMap = { [id: string]: TriageEntry | undefined }
export type Changeset = { [id: string]: TriageEntry | null | undefined }

// Per-property normalisers — collapse "no value" of any shape (missing
// entry, empty string, legacy `deleted: true` for triage) to '' so the
// three-way conflict compare (oldBase / local / chain) doesn't report
// `'red'` vs `undefined` as a conflict when one side just doesn't carry
// the property.
function normColor(entry: TriageEntry | null | undefined): string {
  return typeof entry?.color === 'string' ? entry.color : ''
}
function normTriage(entry: TriageEntry | null | undefined): string {
  if (entry?.triage === 'inprogress' || entry?.triage === 'fixed' || entry?.triage === 'invalid' || entry?.triage === 'deleted') return entry.triage
  if (entry?.deleted) return 'deleted'
  return ''
}
function normComment(entry: TriageEntry | null | undefined): string {
  return typeof entry?.comment === 'string' ? entry.comment : ''
}
function normFix(entry: TriageEntry | null | undefined): string {
  return typeof entry?.fix === 'string' ? entry.fix : ''
}

// Per-property comparison between the user's pre-rebase overlay
// (= unsynced state.* edits captured before the chain landed) and the
// chain's new baseState. Surfaced to the resolver so neither side
// silently flips: a peer's chained change doesn't overwrite the user,
// and (symmetrically) the joining client's local-wins overlay doesn't
// overwrite an already-agreed chain value. Mirrors the per-property
// semantics `hydrateStateFromBaseState` uses on the report-attach path.
//
// Three-way compare against `oldBaseState` so an "unset" intent
// (overlay = null OR its entry omits a property the user previously
// had) conflicts with a chain that re-assigned that property — and vice
// versa. Both silent-loss directions need it: e.g. we disconnect, peer
// sets color, we unset, reconnect → overlay `{X: null}`, chain `{X:
// {color: blue}}`; a two-way (overlay vs chain) sees no disagreement,
// applyChangeset replays the delete, peer's blue is lost (symmetrically
// the user's set overwrites a peer's delete). The three-way says "both
// sides changed FROM oldBase and disagree → conflict". `local` /
// `imported` are '' for the unset side; the dialog renders `<em>none</em>`.
export function collectChainConflicts(
  overlay: Changeset,
  oldBaseState: TriageStateMap,
  newBaseState: TriageStateMap,
): Conflict[] {
  const conflicts: Conflict[] = []
  // Only check ids the user touched (= ids in overlay). Chain-only
  // changes are gap-fills handled by `applyChangeset(newBaseState,
  // overlay)` — ids missing from the overlay get the chain's value.
  for (const id of Object.keys(overlay)) {
    const overlayValue = overlay[id]
    const oldEntry = oldBaseState[id]
    const chainEntry = newBaseState[id]
    // `overlay[id] === null` is the explicit "user deleted" signal;
    // the effective local entry is then null (every property reads
    // as ''). Otherwise the overlay's entry IS the user's view.
    const localEntry = overlayValue ?? null

    const props = [
      { name: 'color' as const, norm: normColor },
      { name: 'triage' as const, norm: normTriage },
      { name: 'comment' as const, norm: normComment },
      { name: 'fix' as const, norm: normFix },
    ]
    for (const { name, norm } of props) {
      const oldVal = norm(oldEntry)
      const localVal = norm(localEntry)
      const chainVal = norm(chainEntry)
      const localChanged = localVal !== oldVal
      const chainChanged = chainVal !== oldVal
      if (localChanged && chainChanged && localVal !== chainVal) {
        conflicts.push({ id, property: name, local: localVal, imported: chainVal })
      }
    }
  }
  return conflicts
}

// Set-equal comparison for `ignoredReports`: an unordered collection of
// report names. A peer's snapshot iterates state.ignoredIds in insertion
// order, an applied chain may order them differently, so a positional
// compare would falsely report changes and produce empty-but-nonzero
// changesets.
function ignoredReportsEqual(a: unknown, b: unknown): boolean {
  const la: string[] = Array.isArray(a) ? a : []
  const lb: string[] = Array.isArray(b) ? b : []
  if (la.length !== lb.length) return false
  if (la.length === 0) return true
  const seen = new Set(la)
  for (const r of lb) if (!seen.has(r)) return false
  return true
}

function entriesEqual(a: TriageEntry, b: TriageEntry): boolean {
  // `triage` is the current shape (`'fixed' | 'invalid' | 'deleted'` or
  // absent). Legacy `deleted: true` from older peers / stored chains
  // compares as 'deleted' — the receive-side migrates on apply, but a
  // local state still carrying the legacy boolean shouldn't false-equal
  // a remote entry that already moved to the new field.
  const triageA = a.triage ?? (a.deleted ? 'deleted' : '')
  const triageB = b.triage ?? (b.deleted ? 'deleted' : '')
  return a.color === b.color
    && triageA === triageB
    && (a.comment ?? '') === (b.comment ?? '')
    && (a.fix ?? '') === (b.fix ?? '')
    && ignoredReportsEqual(a.ignoredReports, b.ignoredReports)
}

export function statesEqual(a: TriageStateMap, b: TriageStateMap): boolean {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const id of ids) {
    if (!entriesEqual(a[id] ?? {}, b[id] ?? {})) return false
  }
  return true
}

// Walk a state through a changeset, producing a new state. `null` in
// the changeset deletes the id. Exported for unit-test access (round-12
// H6 prototype-pollution regression). Pure — no module state/side effects.
export function applyChangeset(baseState: TriageStateMap, changeset: Changeset): TriageStateMap {
  // `Object.create(null)`, not `{}`, so a peer-controlled changeset
  // can't pollute the prototype chain. JSON.parse turns `{"__proto__":
  // …}` into an OWN property; `out['__proto__'] = entry` on a normal
  // `{}` triggers Object.prototype's `__proto__` setter and mutates
  // out's prototype to the attacker entry — every later `baseState[id]`
  // lookup (hydrateStateFromBaseState, statesEqual, …) then walks the
  // polluted chain and returns attacker-controlled triage. Null-prototype
  // out has no setter; the key becomes an inert own property. Audit
  // round-12 H6.
  const out: TriageStateMap = Object.assign(Object.create(null), baseState)
  for (const [id, entry] of Object.entries(changeset)) {
    if (entry === null) delete out[id]
    else if (entry !== undefined) out[id] = entry
  }
  return out
}

// Compute the changeset that turns `base` into `target`. Mirrors
// `applyChangeset` — `null` entries clear, present entries overwrite.
export function computeChangeset(base: TriageStateMap, target: TriageStateMap): Changeset {
  // `Object.create(null)` mirrors `applyChangeset` / `effectiveLocalState`.
  // Otherwise `changeset['__proto__'] = entry` (when `__proto__` shows up
  // in base/target keys) triggers the Object.prototype setter and
  // pollutes the outbound payload's prototype chain. Audit round-12 H6.
  const changeset: Changeset = Object.create(null)
  const ids = new Set([...Object.keys(base), ...Object.keys(target)])
  for (const id of ids) {
    const b = base[id] ?? {}
    const t = target[id] ?? {}
    if (!entriesEqual(b, t)) changeset[id] = target[id] ?? null
  }
  return changeset
}

export function changesetEmpty(cs: Changeset): boolean {
  for (const _ in cs) return false
  return true
}
