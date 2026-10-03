import assert from 'node:assert/strict'

export async function checkGithubMetadataStore(db) {
  const open = { key: '7:pull:1', title: 'Open', description: 'Original body', status: 'open', stateReason: null, fetchedAt: 1, attemptedAt: null }
  await db.setGithubMetadata([open])
  assert.deepEqual(await db.listGithubMetadata([open.key]), [open])
  const merged = { ...open, title: 'Merged', description: 'Merged body', status: 'merged', fetchedAt: 3 }
  await db.setGithubMetadata([merged])
  await db.setGithubMetadata([{ ...open, fetchedAt: 4 }])
  assert.deepEqual(await db.listGithubMetadata([open.key]), [merged], 'a concurrent late response cannot overwrite merged metadata')
  const issue = { ...open, key: '7:issue:1', title: 'Issue', fetchedAt: 10 }
  await db.setGithubMetadata([issue])
  await db.setGithubMetadata([{ ...issue, title: 'Outdated', fetchedAt: 9 }])
  assert.deepEqual(await db.listGithubMetadata([issue.key]), [issue])
  for (const [i, stateReason] of ['completed', 'not_planned', 'duplicate', 'unknown'].entries()) {
    const closed = { ...issue, status: 'closed', stateReason, description: null, fetchedAt: 11 + i }
    await db.setGithubMetadata([closed])
    assert.deepEqual(await db.listGithubMetadata([issue.key]), [closed])
  }
  const many = Array.from({ length: 250 }, (_, i) => ({ ...open, key: `9:pull:${i + 1}` }))
  await db.setGithubMetadata(many)
  assert.equal((await db.listGithubMetadata(many.map(row => row.key))).length, 250)
  assert.deepEqual(await db.listGithubMetadata([open.key]), [merged], 'the persistent cache does not evict older records')
  await db.recordGithubMetadataAttempts([issue.key, 'missing'], 100)
  await db.recordGithubMetadataAttempts([issue.key], 99)
  const [attempted] = await db.listGithubMetadata([issue.key])
  assert.equal(attempted.attemptedAt, 100, 'older concurrent attempts cannot move the entry back in the queue')
  assert.equal(attempted.fetchedAt, 14, 'attempts do not change the successful fetch time')
  assert.equal(attempted.stateReason, 'unknown')
  assert.equal(attempted.title, 'Issue')
  assert.deepEqual(await db.listGithubMetadata(['missing']), [], 'failed attempts do not create successful metadata')
  await db.setGithubMetadata([{ ...attempted, fetchedAt: 101, title: 'Updated' }])
  assert.equal((await db.listGithubMetadata([issue.key]))[0].attemptedAt, 100, 'metadata updates preserve the independent attempt time')
  const publicRepo = { repoId: 7, github: 'Org/Public', public: true, checkedAt: 1 }
  await db.setGithubRepositoryVisibility([publicRepo, { ...publicRepo, repoId: 8 }])
  assert.deepEqual(await db.listGithubRepositoryVisibility([7]), [publicRepo])
  const privateRepo = { ...publicRepo, github: 'Org/Renamed', public: false, checkedAt: 3 }
  await db.setGithubRepositoryVisibility([privateRepo])
  await db.setGithubRepositoryVisibility([{ ...publicRepo, checkedAt: 2 }])
  await db.setGithubRepositoryVisibility([{ ...publicRepo, checkedAt: 3 }])
  assert.deepEqual(await db.listGithubRepositoryVisibility([7]), [privateRepo], 'an older concurrent public response cannot overwrite a newer private observation')
  assert.deepEqual(await db.listGithubRepositoryVisibility([999]), [])
  assert.deepEqual(await db.listGithubRepositoryVisibility([]), [])
  await db.setGithubRepositoryVisibility([])
  return merged
}
