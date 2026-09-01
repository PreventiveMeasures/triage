// `ui/view/analyzer-tags.js` — the run-meta tag strip under the page
// title. Each finding carries the combo of the run that produced it
// (`type · model · effort · exportsMode`), and a merged view can hold
// many combos at once. Pins the three rules the strip depends on:
//   * a field every combo agrees on lifts out into its own chip, and
//     only the varying fields stay inside the per-run tuples;
//   * the import mode, which can't lift out while it varies, folds
//     `list` + `isolate` siblings into one `list+isolate` tuple rather
//     than printing the same run prefix twice;
//   * the tuples sort — run modes by their own ladder (security,
//     correctness, other named modes, null, terminal), models
//     alphabetically — so the strip reads the same across loads
//     regardless of which finding happened to be parsed first.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// analyzer-tags.js → format.js → frontend-global.js throws at module
// load when the `@rray/frontend` slot isn't installed. Tests don't run
// the boot path that installs it, so stub it before the import chain
// evaluates; the tag projection never calls any of these symbols.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const { COMBO_FIELDS, buildAnalyzerTags } = await import('../ui/view/analyzer-tags.js')

// One finding per run combo, spelled the way a native report stamps
// them (`inheritReportMeta` copies the header's run meta onto every
// finding). Models are raw here — `buildAnalyzerTags` prettifies.
function run(type, model, effort, exportsMode) {
  return { type, model, effort, exportsMode }
}

describe('buildAnalyzerTags', () => {
  it('folds import-mode siblings and sorts modes, then models', () => {
    // The full mixed load: one common field (`max`), three varying,
    // and two runs swept in both import modes.
    const tags = buildAnalyzerTags([
      run('security', 'claude-opus-5', 'max', 'isolate'),
      run(null, 'claude-fable-5', 'max', 'list'),
      run('security', 'claude-fable-5', 'max', 'isolate'),
      run('security', 'claude-opus-5', 'max', 'list'),
      run('security', 'claude-fable-5', 'max', 'list'),
      run('correctness', 'claude-fable-5', 'max', 'list'),
    ])
    assert.deepEqual(tags, [
      'max',
      'security · fable 5 · list+isolate',
      'security · opus 5 · list+isolate',
      'correctness · fable 5 · list',
      'null · fable 5 · list',
    ])
  })

  it('orders run modes security → correctness → named → null → terminal', () => {
    const tags = buildAnalyzerTags([
      run('terminal', 'claude-opus-5', 'max', 'list'),
      run(null, 'claude-opus-5', 'max', 'list'),
      run('audit', 'claude-opus-5', 'max', 'list'),
      run('correctness', 'claude-opus-5', 'max', 'list'),
      run('zebra', 'claude-opus-5', 'max', 'list'),
      run('security', 'claude-opus-5', 'max', 'list'),
    ])
    // Only `type` varies, so it stays a labelled standalone chip and
    // the common fields lift out around it.
    assert.deepEqual(tags, [
      'opus 5', 'max',
      'analyzer: security', 'analyzer: correctness', 'analyzer: audit',
      'analyzer: zebra', 'analyzer: null', 'analyzer: terminal',
      'list',
    ])
  })

  it('sorts models alphabetically within a run mode', () => {
    const tags = buildAnalyzerTags([
      run('security', 'openai/gpt-5.5', 'max', 'list'),
      run('security', 'claude-opus-5', 'max', 'list'),
      run('security', 'claude-fable-5', 'max', 'list'),
    ])
    assert.deepEqual(tags, ['max', 'analyzer: security', 'fable 5', 'gpt 5.5', 'opus 5', 'list'])
  })

  it('merges every import mode of a run into one tag when nothing else varies', () => {
    const tags = buildAnalyzerTags([
      run('security', 'claude-opus-5', 'max', 'isolate'),
      run('security', 'claude-opus-5', 'max', 'list'),
    ])
    assert.deepEqual(tags, ['opus 5', 'max', 'analyzer: security', 'list+isolate'])
  })

  it('keeps import modes apart when another varying field separates them', () => {
    // Same model, different effort — the runs aren't siblings, so
    // each keeps its own mode at the tail of its tuple.
    const tags = buildAnalyzerTags([
      run(null, 'claude-opus-4.7', 'xhigh', 'isolate'),
      run(null, 'claude-opus-4.7', 'max', 'list'),
    ])
    assert.deepEqual(tags, ['opus 4.7', 'analyzer: null', 'max · list', 'xhigh · isolate'])
  })

  it('never folds a null import mode into a sibling', () => {
    // A missing mode renders as nothing; merging it would claim the
    // run rode in the sibling's mode.
    const tags = buildAnalyzerTags([
      run('security', 'claude-opus-5', 'max', 'list'),
      run('security', 'claude-opus-5', 'max', null),
    ])
    assert.deepEqual(tags, ['opus 5', 'max', 'analyzer: security', 'list'])
  })

  it('drops the analyzer label once the type shares a tuple with other fields', () => {
    // Three rows with `type` inside the tuple: the repeated prefix
    // stops labelling a separable factor, so the value sits bare.
    const tags = buildAnalyzerTags([
      run('security', 'claude-opus-5', 'max', 'isolate'),
      run('correctness', 'claude-opus-5', 'max', 'list'),
      run(null, 'openai/gpt-5.5', 'xhigh', 'list'),
    ])
    assert.deepEqual(tags, [
      'security · opus 5 · max · isolate',
      'correctness · opus 5 · max · list',
      'null · gpt 5.5 · xhigh · list',
    ])
  })

  it('keeps the analyzer label when folding leaves only two rows', () => {
    // Four combos, but the import-mode fold collapses them to two —
    // the prefix stays readable at that width.
    const tags = buildAnalyzerTags([
      run('security', 'claude-opus-5', 'max', 'list'),
      run('security', 'claude-opus-5', 'max', 'isolate'),
      run('correctness', 'claude-opus-5', 'max', 'list'),
      run('correctness', 'claude-opus-5', 'max', 'isolate'),
    ])
    assert.deepEqual(tags, [
      'opus 5', 'max',
      'analyzer: security · list+isolate',
      'analyzer: correctness · list+isolate',
    ])
  })

  it('sorts efforts strongest first', () => {
    const tags = buildAnalyzerTags([
      run('security', 'claude-opus-5', 'medium', 'list'),
      run('security', 'claude-opus-5', 'max', 'list'),
      run('security', 'claude-opus-5', 'high', 'list'),
      run('security', 'claude-opus-5', 'xhigh', 'list'),
    ])
    assert.deepEqual(tags, ['opus 5', 'analyzer: security', 'max', 'xhigh', 'high', 'medium', 'list'])
  })

  it('honours a narrowed field list', () => {
    // Source-marked reports drop `type` — it's a finding category
    // there, not an analyzer name.
    const findings = [
      run('vulnerability', 'claude-opus-5', 'max', 'list'),
      run('quality', 'claude-opus-5', 'max', 'isolate'),
    ]
    const fields = COMBO_FIELDS.filter((f) => f !== 'type')
    assert.deepEqual(buildAnalyzerTags(findings, fields), ['opus 5', 'max', 'list+isolate'])
  })

  it('drops absent fields and renders a lone combo as its bare chips', () => {
    assert.deepEqual(buildAnalyzerTags([run('correctness', null, null, null)]), ['analyzer: correctness'])
    assert.deepEqual(buildAnalyzerTags([]), [])
  })
})
