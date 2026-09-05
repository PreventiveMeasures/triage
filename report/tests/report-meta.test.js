// `report/meta.js` — the header → finding run-meta projection
// shared by the report view (ui/view/ingest.js) and the OPFS-wide
// finding index (client/bundle-finding-index.js). Pins the rule both
// sides depend on:
//   * inheritance is PER FIELD — a deduplicated dump stamps `model` on
//     each finding while `type` / `think` / `effort` / `exportsMode`
//     stay run-level in the header, and such a finding must still pick
//     the header's `type` up (else its analyzer reads as "(none)" in
//     the header combo tags and the analyzer/model dropdown);
//   * a finding's own value always wins;
//   * null counts as unspecified (JSON has no `undefined`);
//   * source-marked reports (deepsec / codex-security /
//     claude-security) inherit nothing.
//
// Plus `reportRepoGithub`, the report-level `repo.github` declaration
// — deliberately NOT part of that inheritance (a dependency finding's
// own `repo.github` names its upstream, not the scanned project), and
// normalised to an `owner/name` slug so links, the header chip and the
// Repositories view all key off one form.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { META_FIELDS, inheritReportMeta, reportRepoGithub } from '../meta.js'

// The header shape the analyzer emits at the top of a native dump.
const header = () => ({
  type: 'security',
  model: 'moonshotai/kimi-k3',
  think: true,
  effort: 'max',
  exportsMode: 'list',
})

const finding = (extra = {}) => ({
  id: 'f1', severity: 'high', file: 'src/x.js', description: 'd', ...extra,
})

describe('inheritReportMeta', () => {
  it('fills every run-meta field on a finding that carries none', () => {
    const f = finding()
    inheritReportMeta(f, header())
    assert.deepEqual(
      Object.fromEntries(META_FIELDS.map((k) => [k, f[k]])),
      { type: 'security', model: 'moonshotai/kimi-k3', think: true, effort: 'max', exportsMode: 'list' },
    )
  })

  it('fills the remaining fields when only `model` is stamped per finding', () => {
    // The deduplicate command's shape: each finding names the model of
    // the run it came from, the rest of the meta stays in the header.
    const f = finding({ model: 'gpt-5.5' })
    inheritReportMeta(f, header())
    assert.equal(f.model, 'gpt-5.5', 'per-finding model wins over the header')
    assert.equal(f.type, 'security', 'type still inherited')
    assert.equal(f.think, true)
    assert.equal(f.effort, 'max')
    assert.equal(f.exportsMode, 'list')
  })

  it('never overwrites a value the finding specifies', () => {
    const f = finding({ type: 'correctness', effort: 'xhigh', think: false, exportsMode: 'isolate' })
    inheritReportMeta(f, header())
    assert.equal(f.type, 'correctness')
    assert.equal(f.effort, 'xhigh')
    assert.equal(f.think, false, 'a false value is a value, not a gap')
    assert.equal(f.exportsMode, 'isolate')
    assert.equal(f.model, 'moonshotai/kimi-k3', 'the one unspecified field still fills')
  })

  it('treats an explicit null as unspecified (JSON has no undefined)', () => {
    const f = finding({ type: null, model: null })
    inheritReportMeta(f, header())
    assert.equal(f.type, 'security')
    assert.equal(f.model, 'moonshotai/kimi-k3')
  })

  it('does not stamp header fields that are absent or null', () => {
    const f = finding()
    inheritReportMeta(f, { type: 'security', model: null })
    assert.equal(f.type, 'security')
    assert.ok(!('model' in f) || f.model == null, 'no null model stamped')
    assert.equal(f.effort, undefined)
  })

  it('inherits nothing for source-marked reports', () => {
    // deepsec / codex-security / claude-security: the report-level
    // `type` is a whole-file category label, not an analyzer descriptor.
    const f = finding()
    inheritReportMeta(f, { ...header(), source: 'claude-security' })
    for (const k of META_FIELDS) assert.equal(f[k], undefined, `${k} not inherited`)
  })
})

describe('reportRepoGithub', () => {
  const repo = (github) => reportRepoGithub({ repo: { github } })

  it('takes the canonical `owner/name` slug as-is', () => {
    assert.equal(repo('lodash/lodash'), 'lodash/lodash')
    assert.equal(repo('  spaced/slug  '), 'spaced/slug', 'surrounding whitespace trimmed')
    assert.equal(repo('owner/name.git'), 'owner/name', '.git suffix dropped')
  })

  it('normalises a github URL down to the slug', () => {
    // The form links and the chip need — `fileUrl` interpolates the
    // value straight into `github.com/<value>/blob/HEAD/...`, so a
    // full URL left intact would build a broken link.
    for (const url of [
      'https://github.com/owner/name',
      'http://github.com/owner/name.git',
      'github.com/owner/name/',
      'https://www.github.com/owner/name/tree/main',
      'https://github.com/owner/name?tab=readme',
    ]) {
      assert.equal(repo(url), 'owner/name', url)
    }
  })

  it('rejects anything that is not a github repo', () => {
    assert.equal(repo('https://gitlab.com/owner/name'), null, 'other forge')
    assert.equal(repo('owner'), null, 'no repo half')
    assert.equal(repo('a/b/c'), null, 'not a slug')
    assert.equal(repo('owner/na me'), null, 'space inside the slug')
    assert.equal(repo(''), null)
    assert.equal(repo('   '), null)
  })

  it('returns null when the report declares nothing usable', () => {
    assert.equal(reportRepoGithub({}), null)
    assert.equal(reportRepoGithub({ repo: {} }), null)
    assert.equal(reportRepoGithub({ repo: null }), null)
    assert.equal(reportRepoGithub({ repo: { github: null } }), null)
    assert.equal(reportRepoGithub({ repo: { github: 42 } }), null, 'non-string ignored')
    assert.equal(reportRepoGithub(null), null)
  })

  it('is independent of the run-meta inheritance', () => {
    // A source-marked report inherits no run meta, but a repo it
    // declares still counts — the opt-out is about `type` colliding
    // with a category label, which says nothing about the repository.
    assert.equal(reportRepoGithub({ source: 'deepsec', repo: { github: 'owner/name' } }), 'owner/name')
    // And the declaration never lands on the findings themselves.
    const f = finding()
    inheritReportMeta(f, { ...header(), repo: { github: 'owner/name' } })
    assert.equal(f.repo, undefined, 'per-finding repo left alone')
  })
})
