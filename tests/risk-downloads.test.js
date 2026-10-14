import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NpmRiskError, npmReadyDownload, npmReadyDownloads } from '../risk/index.js'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const DAY = 24 * 60 * 60_000
// The days risk asks a package's downloads over at NOW: from the first of
// the month before last to yesterday.
const RANGE = '2026-08-01:2026-10-11'
const DOWNLOADS = `https://api.npmjs.org/downloads/range/${RANGE}/`
const counted = (name, ...days) => ({ package: name, start: '2026-08-01', end: '2026-08-03', downloads: days.map((downloads, at) => ({ day: `2026-08-0${at + 1}`, downloads })) })

// A cache kept in a Map, as risk's callers keep it, downloads by name.
function store(kept = {}) {
  const rows = new Map(Object.entries(kept).map(([name, value]) => [`risk/npm/downloads ${name}`, value]))
  return { rows, read: (type, key) => Promise.resolve(rows.get(`${type} ${key}`) ?? null), write: (type, key, value) => { rows.set(`${type} ${key}`, value); return Promise.resolve() } }
}

// npm's downloads API answering `answer(url)`, each URL asked noted.
function downloadsApi(t, answer) {
  const asked = []
  t.mock.method(globalThis, 'fetch', input => { asked.push(String(input)); return Promise.resolve(answer(String(input))) })
  return asked
}

test('downloads are readied at once where kept, and unscoped ones asked of npm in one lookup, as npmDownloads keeps them; scoped ones left', async t => {
  const asked = downloadsApi(t, url => url === `${DOWNLOADS}left-pad,is-number,gone,old`
    ? Response.json({ 'left-pad': counted('left-pad', 5, 6, 7), 'is-number': counted('is-number', 1, 2, 3), gone: null, old: counted('old', 1) })
    : Response.json({ error: 'not found' }, { status: 404 }))
  const cache = store({ kept: { at: NOW - 6 * DAY, start: '2026-08-01', end: '2026-08-01', days: [9] }, old: { at: NOW - 8 * DAY, none: true } })
  const ready = []
  await npmReadyDownloads(['left-pad', 'kept', '@scope/a', 'is-number', 'left-pad', 'gone', 'old'], name => { ready.push(name) }, { cache, now: NOW })
  assert.deepEqual(asked, [`${DOWNLOADS}left-pad,is-number,gone,old`], 'one lookup of the unscoped ones not kept within a week')
  assert.deepEqual(ready, ['kept', 'left-pad', 'is-number', 'gone', 'old'], 'the scoped one left for npmReadyDownload')
  assert.deepEqual(cache.rows.get('risk/npm/downloads left-pad'), { at: NOW, start: '2026-08-01', end: '2026-08-03', days: [5, 6, 7] })
  assert.deepEqual(cache.rows.get('risk/npm/downloads gone'), { at: NOW, none: true }, 'one npm counts none of')
  // Readied, they ask npm nothing more.
  await npmReadyDownload('left-pad', { cache, now: NOW })
  assert.equal(asked.length, 1)
})

test('a scoped package\'s downloads, or an unscoped one\'s left alone, are readied on their own', async t => {
  const asked = downloadsApi(t, url => Response.json(url.endsWith('/@scope%2fa') ? counted('@scope/a', 1, 1, 1) : counted('alone', 2, 2, 2)))
  const cache = store()
  const ready = []
  await npmReadyDownloads(['@scope/a', 'alone'], name => { ready.push(name) }, { cache, now: NOW })
  assert.deepEqual([asked, ready], [[], []], 'npm answers a lookup of one as that package\'s own, not by its name: none asked at once')
  for (const name of ['@scope/a', 'alone']) await npmReadyDownload(name, { cache, now: NOW })
  assert.deepEqual(asked, [`${DOWNLOADS}@scope%2fa`, `${DOWNLOADS}alone`])
  assert.deepEqual(cache.rows.get('risk/npm/downloads @scope/a').days, [1, 1, 1])
})

test('npm asking to be asked later is thrown as busy, those readied by then told', async t => {
  downloadsApi(t, () => Response.json({}, { status: 429 }))
  const ready = []
  const cache = store({ kept: { at: NOW, none: true } })
  await assert.rejects(npmReadyDownloads(['kept', 'a', 'b'], name => { ready.push(name) }, { cache, now: NOW }),
    error => error instanceof NpmRiskError && error.code === 'upstream-busy')
  assert.deepEqual(ready, ['kept'])
  await assert.rejects(npmReadyDownload('@scope/a', { cache, now: NOW }), error => error.code === 'upstream-busy')
})

test('unscoped packages\' downloads are asked 128 at a time, as npm\'s downloads API answers a lookup', async t => {
  const names = Array.from({ length: 200 }, (_, i) => `pkg-${i}`)
  const asked = downloadsApi(t, url => Response.json(Object.fromEntries(url.slice(DOWNLOADS.length).split(',').map(name => [name, counted(name, 1)]))))
  const ready = []
  await npmReadyDownloads(names, name => { ready.push(name) }, { cache: store(), now: NOW })
  assert.deepEqual(asked.map(url => url.slice(DOWNLOADS.length).split(',').length), [128, 72])
  assert.deepEqual(ready, names)
})
