import assert from 'node:assert/strict'

// Exercise the same provenance rules on SQLite and PostgreSQL.
export async function checkBundleProvenance(db) {
  const insert = (id, provenance, filename = `${id}.stasis.code.br`, kind = 'stasis') => db.insertBundle({
    id, integrity: id, filename, kind, byteSize: 1, uploadedBy: null, uploadedByLogin: 'alice', repoId: null, provenance,
  }, 1)
  const reuse = (id, provenance, filename, kind = 'stasis', rename = true) => db.reuseBundle(id, { provenance, filename, kind, rename })
  const row = async id => {
    const { filename, kind, provenance, uploadedAt } = await db.getBundle(id)
    return { filename, kind, provenance, uploadedAt }
  }
  await insert('uploaded', 'upload')
  await insert('built', 'build')
  await insert('legacy', null)
  await insert('sourcemap', 'upload', 'app.js.map', 'sourcemap')
  await insert('hidden', 'upload')
  await insert('unknown-kind', 'upload', 'archive.bin', null)

  // Uploads rename uploaded rows only; identical retries change nothing.
  assert.equal(await reuse('uploaded', 'upload', 'renamed.stasis.code.br'), true)
  assert.deepEqual(await row('uploaded'), { filename: 'renamed.stasis.code.br', kind: 'stasis', provenance: 'upload', uploadedAt: 1 })
  assert.equal(await reuse('uploaded', 'upload', 'renamed.stasis.code.br'), false)
  assert.equal(await reuse('built', 'upload', 'renamed.stasis.code.br'), false)
  assert.equal(await reuse('legacy', 'upload', 'renamed.stasis.code.br'), false, 'unknown rows may have been built')
  assert.deepEqual(await row('built'), { filename: 'built.stasis.code.br', kind: 'stasis', provenance: 'build', uploadedAt: 1 })
  assert.deepEqual(await row('legacy'), { filename: 'legacy.stasis.code.br', kind: 'stasis', provenance: null, uploadedAt: 1 })

  // A build takes over uploaded and unknown rows, and never renames a build.
  assert.equal(await reuse('uploaded', 'build', 'org-repo.aaaaaaa.stasis.code.br'), true)
  assert.deepEqual(await row('uploaded'), { filename: 'org-repo.aaaaaaa.stasis.code.br', kind: 'stasis', provenance: 'build', uploadedAt: 1 })
  assert.equal(await reuse('uploaded', 'upload', 'again.stasis.code.br'), false)
  assert.equal(await reuse('legacy', 'build', 'org-repo.bbbbbbb.stasis.code.br'), true)
  assert.equal((await row('legacy')).provenance, 'build')
  assert.equal(await reuse('built', 'build', 'org-repo.ccccccc.stasis.code.br'), false)
  assert.equal((await row('built')).filename, 'built.stasis.code.br')

  // Sourcemaps live in another blob store: label them, but keep their name.
  assert.equal(await reuse('sourcemap', 'upload', 'app.stasis.code.br'), false)
  assert.equal(await reuse('sourcemap', 'build', 'org-repo.ddddddd.stasis.code.br'), true)
  assert.deepEqual(await row('sourcemap'), { filename: 'app.js.map', kind: 'sourcemap', provenance: 'build', uploadedAt: 1 })
  // A rename never makes a readable bundle unrecognized, but may recognize one.
  assert.equal(await reuse('uploaded', 'upload', 'bundle', null), false)
  assert.equal(await reuse('unknown-kind', 'upload', 'archive.zip', null), true)
  assert.equal(await reuse('unknown-kind', 'build', 'org-repo.fffffff.stasis.code.br'), true)
  assert.deepEqual(await row('unknown-kind'), { filename: 'org-repo.fffffff.stasis.code.br', kind: 'stasis', provenance: 'build', uploadedAt: 1 })
  // Without rename (a caller who cannot see the row) only the label changes.
  assert.equal(await reuse('hidden', 'upload', 'other.stasis.code.br', 'stasis', false), false)
  assert.equal(await reuse('hidden', 'build', 'org-repo.eeeeeee.stasis.code.br', 'stasis', false), true)
  assert.deepEqual(await row('hidden'), { filename: 'hidden.stasis.code.br', kind: 'stasis', provenance: 'build', uploadedAt: 1 })

  await insert('fresh-build', 'build')
  const listed = new Map((await db.listBundles()).map(bundle => [bundle.id, bundle.provenance]))
  assert.equal(listed.get('fresh-build'), 'build')
  assert.equal(listed.get('legacy'), 'build')
  const actions = new Map((await db.listActivity({ page: 1, limit: 100, kind: 'upload', query: '', contexts: null })).history
    .map(entry => [entry.report, entry.action]))
  assert.equal(actions.get('fresh-build.stasis.code.br'), 'built a bundle')
  assert.equal(actions.get('built.stasis.code.br'), 'built a bundle')
  assert.equal(actions.get('legacy.stasis.code.br'), 'uploaded a bundle', 'unknown rows keep the upload wording')
  assert.equal(actions.get('uploaded.stasis.code.br'), 'uploaded a bundle', 'history keeps what happened at insert time')
}

// Exercise the same build-condition rules on SQLite and PostgreSQL.
export async function checkBundleBuildConditions(db) {
  const node = { preset: 'node', conditions: ['node', 'production'], platforms: [] }
  const metro = { preset: 'metro', conditions: ['react-native'], platforms: ['ios'] }
  const insert = (id, provenance, buildConditions) => db.insertBundle({ id, integrity: id, filename: `${id}.stasis.code.br`, kind: 'stasis',
    byteSize: 1, uploadedBy: null, uploadedByLogin: 'alice', repoId: null, provenance, buildConditions }, 1)
  const reuse = (id, provenance, buildConditions) => db.reuseBundle(id, { provenance, filename: `${id}.stasis.code.br`, kind: 'stasis', rename: true, buildConditions })
  const recorded = async id => (await db.getBundle(id)).buildConditions
  await insert('js', 'build', node)
  await insert('solidity', 'build', null)
  await insert('uploaded', 'upload')
  await insert('legacy', 'build')
  assert.deepEqual(await recorded('js'), node)
  assert.equal(await recorded('solidity'), null)
  assert.equal(await recorded('uploaded'), null)
  assert.equal((await db.getBundleByIntegrity('js')).buildConditions.preset, 'node')

  // Other conditions that rebuild the same bytes describe them equally: keep the first.
  assert.equal(await reuse('js', 'build', metro), false)
  assert.deepEqual(await recorded('js'), node)
  assert.equal(await reuse('js', 'build', null), false)
  assert.equal(await reuse('uploaded', 'upload', metro), false, 'uploads record no conditions')
  assert.equal(await recorded('uploaded'), null)
  // A build records its conditions on uploaded rows and on builds predating the column.
  assert.equal(await reuse('uploaded', 'build', metro), true)
  assert.deepEqual(await recorded('uploaded'), metro)
  assert.equal(await reuse('legacy', 'build', node), true)
  assert.deepEqual(await recorded('legacy'), node)
  assert.equal(await reuse('legacy', 'build', node), false, 'identical retries change nothing')
}
