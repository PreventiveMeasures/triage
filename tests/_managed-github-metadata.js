import assert from 'node:assert/strict'

export async function checkGithubMetadataStore(db) {
  const open = { key: '7:pull:1', title: 'Open', description: 'Original body', status: 'open', fetchedAt: 1 }
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
  const closed = { ...issue, status: 'closed', description: null, fetchedAt: 11 }
  await db.setGithubMetadata([closed])
  assert.deepEqual(await db.listGithubMetadata([issue.key]), [closed])
  const many = Array.from({ length: 250 }, (_, i) => ({ ...open, key: `9:pull:${i + 1}` }))
  await db.setGithubMetadata(many)
  assert.equal((await db.listGithubMetadata(many.map(row => row.key))).length, 250)
  assert.deepEqual(await db.listGithubMetadata([open.key]), [merged], 'the persistent cache does not evict older records')
  return merged
}
