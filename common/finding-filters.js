// What the confidence range, the Confirmed outcome and a workspace's basic
// App view mean for a set of rows. Pure: the view passes its current lens
// (filters.js), and the managed server classifies team workspaces with it.
import { displayedSeverity, revalidateKindOf } from '@preventive/report'

// `tabKey` identifies an individual tab (= finding) across the view.
export function tabKey(f) { return f.id ?? String(f._id) }

// Does this row carry a judgement the pass made ABOUT a finding —
// any stamp but `revalidation`, which names the pass's own row and
// judges nothing. Raw for the same reason as the two above: it gates
// the switch, and a gate that stopped seeing the stamps the moment
// the layer came off would take the way back with it.
export function hasRevalidateStamp(f) {
  const kind = revalidateKindOf(f)
  return kind !== '' && kind !== 'revalidation'
}

// What the toolbar dropdown offers, in the order it lists them —
// answers to "did the pass leave this standing", running from yes to
// no. Fewer options than the field has values:
//
//   * the `revalidation` row rides CONFIRMED — it is the pass itself,
//     re-examining a finding it did not knock down, which is the same
//     answer to that question;
//   * `partial` rides it too. A partial confirmation is a yes to
//     "does this still stand" — the pass narrowed the finding rather
//     than knocking it down — and an option of its own would slice
//     the standing findings in two for a distinction the reader wants
//     the STAMP for, not a filter. It keeps its own stamp on the card.
//   * `unknown` gets no option — a pass that couldn't tell hasn't
//     answered it at all, so there is nothing to filter to. Those rows
//     stay visible with no filter on, like every other row.
export const REVALIDATE_FILTERS = [
  { value: 'confirmed', label: 'Confirmed', kinds: ['confirmed', 'partial', 'revalidation'] },
  { value: 'unreachable', label: 'Unreachable', kinds: ['unreachable'] },
  { value: 'refuted', label: 'Refuted', kinds: ['refuted'] },
]

// The kinds one dropdown value covers, or null when the value names no
// option — filters.js reads that as "no filter" rather than hiding
// every finding behind a value it can't interpret.
export function revalidateFilterKinds(value) {
  return REVALIDATE_FILTERS.find((o) => o.value === value)?.kinds ?? null
}

// How finely Confirmed is drawn, once it has taken the partial rows
// in. The toolbar cycles a chip through these inside the Confirmed row
// (revalidate-filter.js), because "did this survive" and "how
// completely" are one question asked twice, not two filters — and the
// second only has an answer once the first is Confirmed.
export const PARTIAL_MODES = ['', 'exclude', 'only']

// The kinds an outcome selection ACTUALLY matches, with that switch
// applied. All three are the same shape as every other filter here —
// a list of kinds, matched existentially over the group — so the chip
// narrows what Confirmed reaches rather than subtracting from it:
//
//   ''         everything the pass left standing: the row that IS the
//              pass, the full confirmations, the partial ones;
//   'exclude'  the full confirmations only. NOT "everything but the
//              partials": a group is shown for carrying a `confirmed`
//              row, not for lacking a `partial` one, so the pass row
//              on its own no longer stands in for a verdict;
//   'only'     the partial ones.
//
// It bites only on an option that took the partial rows in —
// Confirmed — so a mode left set from an earlier selection can't
// silently narrow Refuted or Unreachable, and callers can pass it
// through without checking which option is up.
export function activeRevalidateKinds(value, partialMode) {
  const kinds = revalidateFilterKinds(value)
  if (!kinds?.includes('partial')) return kinds
  if (partialMode === 'only') return ['partial']
  if (partialMode === 'exclude') return ['confirmed']
  return kinds
}

// A finding's place on the 0—10 confidence scale, or undefined when it
// has none. The one reader every confidence question goes through:
// what the range matches, what the auto-tune counts, and whether the
// control is offered at all (render.js hasAnyConfidence).
//
// Three ways to have a place:
//
//   * a `confidence` the analyzer scored it with;
//   * `critical: true` — the boolean, NOT `severity: 'critical'` —
//     which stands in for a top score;
//   * coming from another producer at all. An import carries no
//     confidence because its producer doesn't emit one (Claude
//     Security's parser reads none), not because anyone was unsure —
//     there is no doubt here for a floor to act on. Reading it as 10
//     keeps it on screen under any floor and out only under a cap
//     that excludes the top: `8—10` and `2—10` show it, `0—5` and
//     `7—9` don't. It also stops one imported report from taking the
//     range away from a workspace: an unscored finding DISABLES the
//     control for everyone (render.js), which left the range filtering
//     nothing and every low-confidence row on screen.
//
// A row the pass knocked down reads as 0 instead, where that matters
// (voidsConfidence) — applied by the callers, since whether a finding
// has a place at all is about the finding, not about the pass.
export function confidenceOnScale(f) {
  if (f.confidence !== undefined) return f.confidence
  if (f.critical === true || f._source) return 10
  return undefined
}

// Does this finding put itself on the scale, rather than ride the
// stand-in confidenceOnScale hands a row that carries no score? A
// number its producer wrote, or the `critical: true` that stands in
// for one.
const scoresItself = (f) => f.confidence !== undefined || f.critical === true

// Is the confidence range a live control over these rows — offered,
// and actually filtering? Two conditions, which the toolbar reads as
// one (render.js hasAnyConfidence):
//
//   * every row has a place on the scale, or the first lift off 0
//     would silently drop the ones that don't. A single analyzer
//     finding with no confidence and no `critical: true` disables the
//     control for the whole set;
//   * something on screen puts ITSELF on that scale. A row riding the
//     stand-in doesn't: a set of nothing but unscored imports is all
//     10s by definition, and a range over one value says nothing.
//     There the control isn't disabled, it isn't offered at all — the
//     toolbar drops the whole block when the outcome dropdown beside
//     it has nothing to offer either.
//
//     What answers this is the SCORE, not who wrote it. Asked as "not
//     an import" it gave the same answer for every producer that emits
//     no confidence — and the wrong one for DeepSec, which rates every
//     finding it reports and whose words this app places on the scale
//     itself (@preventive/report/src/parse-deepsec.js). A workspace of nothing but
//     DeepSec reports is a real range over real numbers, and asking
//     for a non-import took the slider, the confidence sort and the
//     opening floor away from exactly the load whose producer had
//     scored every row in it.
//
// Both halves are asked of the rows ON SCREEN by every caller, since
// this is about a control in front of a reader.
export function rangeApplies(groups) {
  return groups.every((g) => g.every((f) => confidenceOnScale(f) !== undefined))
    && groups.some((g) => g.some(scoresItself))
}

// Does the confidence floor leave this group on screen? The rule
// matchesFilters applies (filters.js), with the upper bound at 10 so only the
// floor bites, hoisted to the group because that is the unit the list
// shows: a group is on screen when ANY of its rows clears the floor —
// an unscored row only at floor 0 unless it is flagged `critical`, and
// a row the pass knocked down reading as 0 whatever number it carries.
function showsAtConfidence(g, min, kindOf) {
  return g.some((f) => {
    const conf = ['refuted', 'unreachable'].includes(kindOf(f)) ? 0 : confidenceOnScale(f)
    return conf === undefined ? min === 0 : conf >= min
  })
}

// The confidence floor a freshly-loaded set should OPEN on, tuned so
// the initial view fits ~25 groups. Step up 6 → 7 → 8 until the
// visible count is within budget; cap at 8 (the old static default).
// Nothing carrying a confidence at all means no floor — without that
// guard countAtMin(6) = 0 ≤ 25 lands it at 6, which then excludes
// every finding; 0 lets the filter no-op instead, and the toolbar
// hides the control anyway (see toolbarHtml in render.js).
//
// After picking the base, walk DOWN while each lower step surfaces no
// new groups — i.e. there's a "gap" in the confidence distribution
// below the chosen floor. Lowering for free puts the slider at the
// natural break: e.g. picked 8, nothing at 7 or 6 but some at 5 →
// settle at 6 (the lowest step revealing nothing new). Down to 0.
//
// Pure in its argument, and paired with defaultRevalidateFilter below:
// together they are "what does this set open on", asked by ingest.js
// on a first load and again by the App switch (events.js), which
// reshapes the set and so has to ask again rather than keep an answer
// that was about a different one.
export function defaultConfidenceFloor(groups, tabs) {
  // App mode folds the source tabs a revalidation pass already answered
  // under its App tab. Those hidden copies must not lower the opening floor
  // for a workspace that otherwise has the same visible rows as its App
  // report. Keep source-only rows intact; they are real rows in the App view.
  const visible = groups.map(tabs).filter((g) => g.length > 0)
  if (!visible.some((g) => g.some((f) => confidenceOnScale(f) !== undefined))) return 0
  const countAtMin = (min) => visible.reduce((n, g) =>
    n + (g.some((f) => (confidenceOnScale(f) ?? -1) >= min) ? 1 : 0), 0)
  let base
  if (countAtMin(6) <= 25) base = 6
  else if (countAtMin(7) <= 25) base = 7
  else base = 8
  while (base > 0 && countAtMin(base - 1) === countAtMin(base)) base--
  return base
}

// The floor the default view will REALLY apply. The range is a
// whole-set control: one finding on screen with no confidence and no
// `critical: true` and render.js disables it and resets the bounds to
// 0—10 (hasAnyConfidence there), so the auto-tuned floor never bites
// and every row is on screen — an unscored finding is not hidden by a
// filter that isn't running. Measuring the comparison below against a
// floor the view is about to throw away would be measuring a screen
// nobody sees.
//
// `critical: true` rides the 10 bucket in place of a score
// (matchesFilters), so it doesn't block the range any more than a
// number does.
//
// render.js asks this of the on-screen bucket and we ask it of the
// whole set; at open time, before anything is triaged away, they are
// the same groups.
function effectiveFloor(groups, confMin) {
  return rangeApplies(groups) ? confMin : 0
}

// Both the opening default and the dropdown lock use the same coverage:
// findings represented by Confirmed rows, plus findings explicitly ruled out.
// Read the original groups before `tabs` folds away their source members.
export function confirmedCoverage(groups, tabs, kindOf) {
  // A workspace may carry an un-stamped source copy from report A while
  // report B explicitly ruled out the same id. The ruled-out copy is
  // removed before workspace rows are merged, so it cannot vouch for its
  // source copy during the coverage check below. Remember those ids before
  // that projection disappears: Confirmed may hide the source copy too,
  // even when the App finding that caused the ruling has no
  // `revalidateInputs` list of its own.
  const covered = new Set(groups.ruledOutIds ?? [])
  for (const raw of groups) {
    for (const f of raw) if (['refuted', 'unreachable'].includes(kindOf(f))) covered.add(tabKey(f))
  }
  for (const raw of groups) {
    const g = tabs(raw)
    if (g.length === 0) continue
    if (!g.some((f) => activeRevalidateKinds('confirmed', '').includes(
      kindOf(f) || (f._source && !f._sourcePass ? 'revalidation' : '')))) continue
    // A folded source copy is not a cost of Confirmed, but its id is still
    // represented by the App row. Keep all raw members in the coverage set
    // so a duplicate source-only row from another report is recognized as
    // the same issue rather than making Confirmed look lossy.
    for (const f of raw) {
      covered.add(tabKey(f))
      // App reports can carry the source findings they represent only as
      // `revalidateInputs`, rather than as members of the same physical row.
      // Those inputs are still present in the App row's visible result, so a
      // duplicate source-only row from another report must not keep the
      // workspace on Confidence.
      if (f.isApp && Array.isArray(f.revalidateInputs)) {
        for (const id of f.revalidateInputs) if (id) covered.add(id)
      }
    }
  }
  return covered
}

export function confirmedIsDefault(visible, confMin, covered, kindOf) {
  const floor = effectiveFloor(visible, confMin)
  const shown = visible.filter((g) => showsAtConfidence(g, floor, kindOf))
  if (shown.length === 0) return false
  const kinds = new Set(activeRevalidateKinds('confirmed', ''))
  if (!visible.some((g) => g.some((f) => kinds.has(kindOf(f))))) return false
  return shown.every((g) => g.every((f) => covered.has(tabKey(f))))
}

// The same coverage test evaluates a workspace's basic App view without the
// reader's current lens: the view and the managed server pass the lens to use.
export function canLockConfirmed(groups, { tabs, kindOf, severityMode }) {
  const visible = groups.map(tabs).filter((g) => g.length > 0)
  const covered = confirmedCoverage(groups, tabs, kindOf)
  if (!confirmedIsDefault(visible, defaultConfidenceFloor(groups, tabs), covered, kindOf)) return false
  const floor = effectiveFloor(visible, 6)
  return visible.every((g) => !showsAtConfidence(g, floor, kindOf)
    || !g.some((f) => displayedSeverity(f, severityMode) !== 'low')
    || g.every((f) => covered.has(tabKey(f))))
}
