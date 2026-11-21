// Header analyzer tags — the `max` / `security · opus 5 · list+isolate`
// strip under the page title: pure (findings in, display strings out),
// holding the header's trickiest rules — which run-meta fields lift out
// into their own chip, how the rest fold into tuples, and their order.
import { prettyModel } from './format.js'

// Canonical order of the combo fields: each finding contributes one combo
// of these, lifted off its run meta at ingest; several arise when a view
// merges analyzer outputs.
export const COMBO_FIELDS = ['type', 'model', 'effort', 'exportsMode']

// Run mode (`type`) order: the two headline modes lead, then any other
// alphabetically, the unlabelled bucket, and `terminal` last (a captured
// session, the strip's footnote).
const TYPE_ORDER = ['security', 'correctness']

// Reasoning effort, strongest first; unknown spellings after, alphabetically.
const EFFORT_ORDER = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal']

// Import mode, and the order inside a merged `list+isolate`.
const EXPORTS_ORDER = ['list', 'isolate']

// Listed values in order, unknown ones after them, a missing one last.
function rankIn(order, value) {
  if (value == null) return order.length + 1
  const i = order.indexOf(value)
  return i === -1 ? order.length : i
}

// A ladder per COMBO_FIELDS slot. `type` pins `terminal` behind even the
// null bucket; `model` has none, its names ranking alike (alphabetical
// tiebreak) with null last.
const FIELD_RANK = {
  type: (v) => (v === 'terminal' ? TYPE_ORDER.length + 2 : rankIn(TYPE_ORDER, v)),
  model: (v) => (v == null ? 1 : 0),
  effort: (v) => rankIn(EFFORT_ORDER, v),
  exportsMode: (v) => rankIn(EXPORTS_ORDER, v),
}

// By the canonical field order, each field on its ladder, alphabetical
// within a rank. The full tuple sorts, so the strip holds still across
// loads whatever finding was read first.
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

// A field's tag text. `type` always renders, labelled `analyzer: ` (null
// included: "this run had no analyzer subtype") unless `typePrefix` is off;
// other fields are null when missing, so the caller drops them.
function formatComboField(field, value, { typePrefix = true } = {}) {
  if (field === 'type') return typePrefix ? `analyzer: ${value ?? 'null'}` : `${value ?? 'null'}`
  return value ?? null
}

// Fold rows that differ only in import mode into one `list+isolate` tail
// (the incoming sort has them in EXPORTS_ORDER), instead of repeating the
// whole analyzer / model / effort prefix per mode. A null mode renders as
// nothing, so it never merges: that would claim the sibling's mode.
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

// The loaded findings as meta-row tags. The fields describe one run each,
// so they can't be a Set per field: the unique combos (over `fields`, a
// narrower list suppressing a slot — source-marked reports drop `type`,
// the title naming the product) are sorted; a field every combo agrees on
// is "common" and emits one chip at its slot (common model / effort ahead
// of the analyzer chip: the run reads model-first); at the first varying
// slot every row emits one tag of its varying fields joined by ` · `, the
// import-mode siblings folded, an all-empty row skipped.
//
// Examples (combos as `type · model · effort · exportsMode`):
//   `null · opus 4.7 · max · list` + `null · gpt 5.5 · xhigh · list`
//     → `analyzer: null` `gpt 5.5 · xhigh` `opus 4.7 · max` `list`
//   `null · opus 4.7 · xhigh · isolate` + `null · opus 4.7 · max · list`
//     → `opus 4.7` `analyzer: null` `max · list` `xhigh · isolate`
//   `correctness · null · null · null`  →  `analyzer: correctness`
//
// When `type` varies inside a multi-field tuple, over more than two rows,
// the `analyzer:` prefix labels no separable factor and only repeats down
// the strip, so it goes:
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
  // A common import mode lifts out into its own chip: nothing to fold.
  const rows = varyingSlots.includes('exportsMode')
    ? mergeExportsRows(combos, fields)
    : combos
  const dropAnalyzerPrefix = rows.length > 2
    && varyingSlots.includes('type')
    && varyingSlots.length > 1
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
