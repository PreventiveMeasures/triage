import assert from 'node:assert/strict'

export async function checkBundleBuildLeases(db, peer, expire) {
  assert.equal(await db.claimBundleBuildLease('user-a', 'first'), true)
  assert.equal(await peer.claimBundleBuildLease('user-a', 'duplicate'), false, 'one user cannot fan out to another instance')
  assert.equal(await peer.claimBundleBuildLease('user-b', 'second'), true)
  assert.equal(await db.claimBundleBuildLease('user-c', 'third'), false, 'two slots total across instances')
  await peer.releaseBundleBuildLease('not-an-owner')
  assert.equal(await db.claimBundleBuildLease('user-c', 'third'), false)
  await db.releaseBundleBuildLease('first')
  assert.equal(await peer.claimBundleBuildLease('user-a', 'replacement'), true, 'completion frees the user and slot')
  await expire('replacement')
  assert.equal(await db.claimBundleBuildLease('user-a', 'successor'), true, 'expired crash leases are reclaimable')
  await peer.releaseBundleBuildLease('replacement')
  assert.equal(await db.claimBundleBuildLease('user-c', 'third'), false, 'late cleanup cannot release the successor')
  await db.releaseBundleBuildLease('successor')
  await peer.releaseBundleBuildLease('second')
  assert.equal(await db.claimBundleBuildLease('user-c', 'third'), true)
  await db.releaseBundleBuildLease('third')
}
