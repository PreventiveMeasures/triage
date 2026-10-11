import assert from 'node:assert/strict'
import { test } from 'node:test'
import { railLetters } from '../ui/view/sidebar-rail.js'

test('collapsed sidebar names a team or workspace by two letters', () => {
  assert.equal(railLetters('Security fixtures'), 'SF')
  assert.equal(railLetters('Platform-review team'), 'PR')
  assert.equal(railLetters('Frontend'), 'Fr')
  assert.equal(railLetters('NPM'), 'NP')
  assert.equal(railLetters('Ö'), 'Ö')
  assert.equal(railLetters('🦊 Fox'), '🦊F')
  assert.equal(railLetters(''), '')
})

test('collapsed sidebar keeps a lowercase name lowercase', () => {
  assert.equal(railLetters('platform-review team'), 'pr')
  assert.equal(railLetters('security Fixtures'), 'sF')
  assert.equal(railLetters('  ops  '), 'op')
  assert.equal(railLetters('eBay'), 'eB')
})
