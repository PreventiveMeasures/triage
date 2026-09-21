// `ui/view/silenced-gaps.js` — which of a run's `unsupported` entries
// the command line threw away before anyone could read them, and so
// which ones the terminal UI has to surface itself.
//
// The rule is a containment check against the two streams the
// transcript renders, which is subtle enough to be worth pinning from
// both ends: a gap already on screen must not be repeated as a hint,
// and a gap a redirect, a pipe, a gate or a subshell threw away must
// not be lost. `2>&1` is the case that needs both streams — it moves
// a diagnostic into stdout rather than silencing it. All of it is
// checked against real `@preventive/terminal` runs as well as hand-
// built results, because the relationship between the channels is the
// package's to define, not ours to assume.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// A leaf: silenced-gaps.js imports nothing, so it loads without the
// frontend global the rest of ui/view/ needs.
const { silencedGaps } = await import('../ui/view/silenced-gaps.js')
const { createTerminal } = await import('@preventive/terminal')

const run = (line) => createTerminal(
  new Map([['/a.txt', 'x\n'], ['/src/app.js', 'y\n']]),
  { mount: '/sources', home: '/', writable: '/tmp/' },
).run(line)

describe('silencedGaps — the containment rule', () => {
  it('reports nothing when there are no gaps', () => {
    assert.deepEqual(silencedGaps({ stdout: '', stderr: '', unsupported: [] }), [])
    assert.deepEqual(silencedGaps({ stdout: '', stderr: 'cat: nope: No such file\n', unsupported: [] }), [])
  })

  it('leaves out a gap whose message reached stderr', () => {
    const gap = { message: 'ls: unknown option: --bogus' }
    assert.deepEqual(silencedGaps({ stdout: '', stderr: 'ls: unknown option: --bogus\n', unsupported: [gap] }), [])
  })

  it('reports a gap that stderr never carried', () => {
    const gap = { message: 'ls: unknown option: --bogus' }
    assert.deepEqual(silencedGaps({ stdout: '', stderr: '', unsupported: [gap] }), ['ls: unknown option: --bogus'])
  })

  it('counts a shell-level gap as visible despite the `error: ` prefix', () => {
    // The entry's message omits the prefix that stderr carries, which
    // is why the check is containment rather than equality.
    const gap = { message: 'a loop running more than 10000 times is not supported' }
    const stderr = 'error: a loop running more than 10000 times is not supported\n'
    assert.deepEqual(silencedGaps({ stdout: '', stderr, unsupported: [gap] }), [])
  })

  it('leaves out a gap that `2>&1` moved into stdout', () => {
    // `2>&1` does not silence a diagnostic, it relocates it. Both
    // streams are rendered, so the message is still on screen.
    const gap = { message: 'foo: command not found' }
    assert.deepEqual(silencedGaps({ stdout: 'foo: command not found\n', stderr: '', unsupported: [gap] }), [])
  })

  it('splits a mixed run, keeping only the silenced half', () => {
    const seen = { message: 'ls: unknown option: --bogus' }
    const hidden = { message: 'cat: unknown option: --nope' }
    const stderr = 'ls: unknown option: --bogus\n'
    assert.deepEqual(silencedGaps({ stdout: '', stderr, unsupported: [seen, hidden] }), ['cat: unknown option: --nope'])
  })
})

describe('silencedGaps — against real terminal runs', () => {
  it('stays quiet when the gap is already in the transcript', async () => {
    for (const line of ['foo', 'ls --bogus', 'while true; do :; done']) {
      const r = await run(line)
      assert.notEqual(r.unsupported.length, 0, `${line} hits a gap`)
      assert.notEqual(r.stderr, '', `${line} reports it on stderr`)
      assert.deepEqual(silencedGaps(r), [], `${line} needs no hint`)
    }
  })

  // Each of these is a way a command line can discard stderr while the
  // `unsupported` channel keeps the entry. Without the hint the run
  // looks like it simply did nothing.
  for (const [what, line] of [
    ['a redirect to /dev/null', 'foo 2>/dev/null'],
    ['folding into stdout and filtering it away', 'foo 2>&1 | grep -c nothing'],
    ['a gate that replaces the status', 'foo 2>/dev/null; echo after'],
    ['a subshell', '( foo ) 2>/dev/null'],
    ['an unknown option, silenced', 'ls --bogus 2>/dev/null'],
  ]) {
    it(`recovers the gap ${what}`, async () => {
      const r = await run(line)
      assert.equal(r.stderr, '', 'the command line silenced stderr')
      assert.notEqual(r.unsupported.length, 0, 'but the channel still carries it')
      const hidden = silencedGaps(r)
      assert.equal(hidden.length, r.unsupported.length, 'every silenced gap is recovered')
      assert.ok(hidden.every((m) => m.length > 0))
    })
  }

  // The stderr-only version of this check called `foo 2>&1` silenced
  // and hinted a message the transcript was already showing.
  it('stays quiet when `2>&1` moves the gap into stdout', async () => {
    const r = await run('foo 2>&1')
    assert.equal(r.stderr, '', 'stderr is empty')
    assert.ok(r.stdout.includes('command not found'), 'but stdout carries the diagnostic')
    assert.deepEqual(silencedGaps(r), [], 'so there is nothing to hint')
  })

  it('still recovers it once the pipe drops what 2>&1 moved', async () => {
    const r = await run('foo 2>&1 | grep -c nothing')
    assert.equal(r.stderr, '')
    assert.ok(!r.stdout.includes('command not found'), 'grep replaced it with a count')
    assert.deepEqual(silencedGaps(r), r.unsupported.map((u) => u.message))
  })

  // `unsupported` is deduplicated per run, so hitting one gap twice
  // leaves a single entry. When either hit reported it, the user has
  // seen it and no hint is due; only when every hit was silenced is
  // there something left to say.
  it('treats one gap hit twice as the single entry it is', async () => {
    for (const line of ['foo; foo 2>/dev/null', 'foo 2>/dev/null; foo']) {
      const r = await run(line)
      assert.equal(r.unsupported.length, 1, `${line} reports one entry`)
      assert.deepEqual(silencedGaps(r), [], `${line} was reported to the user once`)
    }
    const hidden = await run('foo 2>/dev/null; foo 2>/dev/null')
    assert.equal(hidden.unsupported.length, 1)
    assert.deepEqual(silencedGaps(hidden), hidden.unsupported.map((u) => u.message))
  })

  it('recovers only the silenced one when a line hides half its gaps', async () => {
    const r = await run('ls --bogus; cat --nope 2>/dev/null')
    assert.deepEqual(r.unsupported.map((u) => u.detail).toSorted(), ['--bogus', '--nope'])
    assert.deepEqual(silencedGaps(r), ['cat: unknown option: --nope'])
  })

  it('says nothing about a run that hit no gap at all', async () => {
    const r = await run('cat /sources/a.txt')
    assert.deepEqual(r.unsupported, [])
    assert.deepEqual(silencedGaps(r), [])
  })
})
