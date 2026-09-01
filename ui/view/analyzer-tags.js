// Header analyzer tags — the `max` / `security · opus 5 · list+isolate`
// strip under the page title. Lives apart from render.js because the
// projection is pure (findings in, display strings out) and carries
// the trickiest presentation rules in the header: which run-meta
// fields lift out into their own chip, how the rest fold into tuples,
// and in what order the tuples read.
import { prettyModel } from './format.js'

// Canonical order for analyzer-combo fields. Each finding contributes
// one combo (a tuple of these four values lifted off the run-meta at
// ingest); multiple combos arise when the user merges several
// analyzer outputs into a single view.
export const COMBO_FIELDS = ['type', 'model', 'effort', 'exportsMode']

// Display order for the run mode (`type`). The two headline modes lead
// — a mixed load is nearly always "the security pass, plus something
// else" — then any other named mode alphabetically, then the unlabelled
// bucket, and `terminal` last: it captures a session rather than
// analyzing the tree, so it reads as the footnote of the strip.
const TYPE_ORDER = ['security', 'correctness']

// Reasoning effort, strongest run first. Unknown spellings sort after
// the known ladder (alphabetically, via the comparator's tiebreak).
const EFFORT_ORDER = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal']

// Import mode. Also the order inside a merged `list+isolate` value —
// see `mergeExportsRows`.
const EXPORTS_ORDER = ['list', 'isolate']

// Rank a value against a known order: listed values in that order,
// unknown ones after them, a missing value last of all.
function rankIn(order, value) {
  if (value == null) return order.length + 1
  const i = order.indexOf(value)
  return i === -1 ? order.length : i
}

// Per-field sort rank — one entry per `COMBO_FIELDS` slot, so a new
// slot there needs its ladder here. `type` is the one field whose
// null bucket isn't last (`terminal` sits behind it), so it spells
// its ladder out rather than leaning on `rankIn`'s null-last rule.
// `model` has no meaningful ladder: everything named ranks alike and
// the comparator's alphabetical tiebreak orders it.
const FIELD_RANK = {
  type: (v) => {
    if (v === 'terminal') return TYPE_ORDER.length + 2
    if (v == null) return TYPE_ORDER.length + 1
    const i = TYPE_ORDER.indexOf(v)
    return i === -1 ? TYPE_ORDER.length : i
  },
  model: (v) => (v == null ? 1 : 0),
  effort: (v) => rankIn(EFFORT_ORDER, v),
  exportsMode: (v) => rankIn(EXPORTS_ORDER, v),
}

// Order combos by the canonical field order, each field on its own
// ladder with an alphabetical tiebreak inside a rank. Sorting by the
// full tuple (not just the varying slots) costs nothing — common
// fields tie — and keeps the emitted strip stable across loads, where
// raw combo order follows whichever finding happened to be read first.
function compareCombos(a, b, fields) {
  for (const k of fields) {
    const rank = FIELD_RANK[k]
    const d = rank(a[k]) - rank(b[k])
    if (d !== 0) return d
    const t = String(a[k] ?? '').localeCompare(String(b[k] ?? ''))
    if (t !== 0) return t
  }
  return 0
}

// Format a single combo-field value as a tag-display string. The
// type field carries the `analyzer: ` label and always renders (even
// when null) so the slot is never silently dropped — `analyzer: null`
// reads as "this run had no analyzer subtype". Pass `typePrefix: false`
// to render the bare type value without the label, for tuples where the
// prefix no longer marks a separable factor (see `buildAnalyzerTags`).
// Non-type fields return null when the value is missing so the caller
// can drop them; a bare `null` for a missing model / effort / exports
// just clutters the header.
function formatComboField(field, value, { typePrefix = true } = {}) {
  if (field === 'type') return typePrefix ? `analyzer: ${value ?? 'null'}` : `${value ?? 'null'}`
  if (value == null) return null
  return value
}

// Fold import-mode siblings into one row. When `exportsMode` varies it
// can't lift out into a standalone chip, so it rides at the tail of
// every tuple — and a run swept in both modes would otherwise print
// its whole analyzer / model / effort prefix twice, once per mode, for
// a difference of one word. Rows agreeing on every other field merge
// into a single `list+isolate` tail instead (EXPORTS_ORDER's order,
// which the incoming sort has already put them in).
//
// A null exports mode never merges: it renders as nothing at all (see
// `formatComboField`), so folding it into a sibling would silently
// claim that run ran in the sibling's mode.
function mergeExportsRows(combos, fields) {
  const keyFields = fields.filter((k) => k !== 'exportsMode')
  const rows = []
  const byKey = new Map()
  for (const combo of combos) {
    if (combo.exportsMode == null) {
      rows.push({ ...combo })
      continue
    }
    const key = keyFields.map((k) => combo[k] ?? '').join('|')
    const prev = byKey.get(key)
    if (prev) {
      prev.exportsMode = `${prev.exportsMode}+${combo.exportsMode}`
      continue
    }
    const row = { ...combo }
    byKey.set(key, row)
    rows.push(row)
  }
  return rows
}

// Project the loaded findings into a list of meta-row tag strings. The
// fields aren't independent flags — they describe one analyzer run
// each — so a naive `Set` per field would drop the cross-field
// relationship. This routine instead:
//
//   1. Builds the list of unique combos across all findings, over
//      whichever subset of `COMBO_FIELDS` the caller requested, and
//      orders them (see `compareCombos`).
//   2. Marks each field "common" when every combo agrees on its value
//      and "varying" otherwise.
//   3. Folds import-mode siblings together (see `mergeExportsRows`)
//      into the rows the strip will show.
//   4. Walks the slot order, emitting common fields as single-value
//      tags at their natural slot. The first time a varying slot is
//      hit, every row is emitted as one tag joined by ` · ` over
//      the varying fields only — preserving the cross-field tuple
//      while hiding the common columns that would just repeat.
//
// `formatComboField` runs at every emission point: the type field
// gets the `analyzer: ` prefix, and missing non-type values are
// dropped. A row whose entire varying-field projection is empty
// (after null filtering) is skipped entirely so a single all-empty
// combo doesn't render an empty tag.
//
// `fields` defaults to all four slots; pass a narrower list (e.g.
// without `type`) to suppress a slot — used for source-marked
// reports where the per-finding `type` is a category, not an
// analyzer name, and the title already conveys the product.
//
// When `model` / `effort` end up as their own chips (i.e. common across
// every combo, so they aren't folded into the varying-tuple chip), they
// surface before the `analyzer:` chip — the run identity reads more
// naturally model-first than analyzer-first. Varying tuples stay at the
// first-varying slot in canonical order so the tuple text keeps reading
// `model · effort · exportsMode`.
//
// Examples (combos as `type · model · effort · exportsMode`):
//   `null · opus 4.7 · max · list` + `null · gpt 5.5 · xhigh · list`
//     → `analyzer: null` `gpt 5.5 · xhigh` `opus 4.7 · max` `list`
//   `null · opus 4.7 · xhigh · isolate` + `null · opus 4.7 · max · list`
//     → `opus 4.7` `analyzer: null` `max · list` `xhigh · isolate`
//   `correctness · null · null · null`  →  `analyzer: correctness`
//
// When `type` itself varies inside a multi-field tuple (so it no longer
// renders as its own standalone chip) AND there are more than two rows,
// the `analyzer:` prefix no longer labels a separable factor and just
// repeats down the strip, so it's dropped — each tuple reads as a bare
// value list:
//   `security · opus 5 · max · isolate` + `null · fable 5 · max · list`
//   + `security · fable 5 · max · isolate` + `security · opus 5 · max · list`
//   + `security · fable 5 · max · list` + `correctness · fable 5 · max · list`
//     → `max` `security · fable 5 · list+isolate`
//       `security · opus 5 · list+isolate` `correctness · fable 5 · list`
//       `null · fable 5 · list`
export function buildAnalyzerTags(findings, fields = COMBO_FIELDS) {
  const comboMap = new Map()
  for (const f of findings) {
    const combo = {}
    for (const k of fields) {
      combo[k] = k === 'model' ? (prettyModel(f.model) ?? null) : (f[k] ?? null)
    }
    const key = fields.map((k) => combo[k] ?? '').join('|')
    if (!comboMap.has(key)) comboMap.set(key, combo)
  }
  const combos = [...comboMap.values()].toSorted((a, b) => compareCombos(a, b, fields))
  if (combos.length === 0) return []

  const isCommon = {}
  for (const k of fields) {
    isCommon[k] = new Set(combos.map((c) => c[k])).size === 1
  }
  const varyingSlots = fields.filter((k) => !isCommon[k])

  // Import modes only merge when the slot varies; when it's common it
  // already lifts out into its own chip and there's nothing to fold.
  const rows = varyingSlots.includes('exportsMode')
    ? mergeExportsRows(combos, fields)
    : combos

  // The `analyzer:` prefix only reads as a label when `type` renders as
  // its own standalone chip — when it's common across every combo, or the
  // sole varying slot. This routine collapses ALL varying fields into one
  // `·` tuple (it never factors a product back out), so the moment `type`
  // shares a varying tuple with another field it's no longer standalone
  // and the repeated prefix just clutters each tuple. Past two such
  // rows, drop it and let the type value sit bare at the tuple head.
  const dropAnalyzerPrefix = rows.length > 2
    && varyingSlots.includes('type')
    && varyingSlots.length > 1

  // Promote common model / effort ahead of the analyzer-type chip; the
  // remaining fields keep their canonical order so varying tuples still
  // emit at the first-varying slot.
  const promoted = ['model', 'effort'].filter((k) => fields.includes(k) && isCommon[k])
  const emitOrder = [...promoted, ...fields.filter((k) => !promoted.includes(k))]

  const tags = []
  let rowsEmitted = false
  for (const k of emitOrder) {
    if (isCommon[k]) {
      const t = formatComboField(k, rows[0][k])
      if (t != null) tags.push(t)
    } else if (!rowsEmitted) {
      for (const row of rows) {
        const parts = varyingSlots
          .map((s) => formatComboField(s, row[s], { typePrefix: !dropAnalyzerPrefix }))
          .filter((p) => p != null)
        if (parts.length > 0) tags.push(parts.join(' · '))
      }
      rowsEmitted = true
    }
  }
  return tags
}
