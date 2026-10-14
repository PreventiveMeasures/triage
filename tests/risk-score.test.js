import { test } from 'node:test'
import assert from 'node:assert/strict'
import { npmExposure, npmRiskLevel, npmRiskScore } from '../risk/npm/score.js'

const NOW = Date.parse('2026-10-13T12:00:00Z')
const daysAgo = days => new Date(NOW - days * 86_400_000).toISOString()
const finding = (id, severity) => ({ id, severity })
const scored = (findings, options = {}) => npmRiskScore(findings, { now: NOW, published: daysAgo(1), ...options })

test('a version\'s findings raise its score, each less the more there are, none past 100', () => {
  assert.deepEqual(scored([]), { score: 0, level: 'low', raised: [] }, 'nothing found')
  assert.equal(scored([finding('held-runs-code', 'high')]).score, 20)
  assert.equal(scored([finding('held-runs-code', 'high'), finding('held-unused-deps', 'high')]).score, 36, 'two orange')
  assert.equal(scored([finding('publisher', 'critical')]).score, 50, 'one red')
  assert.equal(scored([finding('held-runs-code', 'critical'), finding('large-code', 'critical')]).score, 75, 'two red')
  const attack = scored(['held-runs-code', 'held-exfiltration', 'large-code', 'held-obfuscated'].map(id => finding(id, 'critical')).concat([finding('held-install-scripts', 'high')]))
  assert.equal(attack.score, 95)
  assert.equal(attack.level, 'critical')
  assert.deepEqual(scored([finding('publisher', 'moderate'), finding('publisher', 'low'), finding('x', 'notice')]).raised, [finding('publisher', 'moderate'), finding('publisher', 'low')],
    'a notice raises none')
  assert.deepEqual(scored([finding('too-new', 'high')]), { score: 0, level: 'low', raised: [] }, 'a version too new is told by its age instead')
})

test('malware is all of it, however long the version has been out', () => {
  assert.deepEqual(npmRiskScore([finding('malware', 'critical')]), { score: 100, level: 'critical', raised: [finding('malware', 'critical')] })
  assert.equal(scored([finding('malware', 'critical')], { published: daysAgo(3000), tier: 10 }).score, 100)
})

test('a version long out among many who download it is lowered: its exposure', () => {
  // progress@2.0.3: a publisher npm's most downloaded packages know gave way
  // to one new to it, in 2018; out ever since among millions.
  const progress = scored([finding('publisher', 'critical')], { published: daysAgo(2869), tier: 1000 })
  assert.equal(progress.score, 7)
  assert.equal(progress.level, 'low')
  assert.deepEqual(progress.lowered, { days: 2869, tier: 1000, by: 0.86 })
  assert.equal(scored([finding('publisher', 'critical')], { published: daysAgo(2869), tier: 10 }).score, 5, 'the top 200 fully: a tenth kept')
  assert.equal(scored([finding('publisher', 'critical')], { published: daysAgo(2869), tier: Infinity }).score, 46, 'one few download hardly')
  assert.equal(scored([finding('publisher', 'critical')], { published: daysAgo(2869), tier: null }).score, 39, 'one whose downloads aren\'t known a little')
  const fresh = scored([finding('publisher', 'critical')], { published: daysAgo(13), tier: 10 })
  assert.equal(fresh.score, 50, 'an attack on the most downloaded is new: none lowered under two weeks')
  assert.equal(fresh.lowered, undefined)
  assert.equal(scored([finding('publisher', 'critical')], { published: null, tier: 10 }).score, 50, 'nor where when it was published isn\'t known')
})

test('exposure: from two weeks out to two years, on a log scale, by the package\'s tier', () => {
  assert.equal(npmExposure(daysAgo(14), NOW, 10), 0)
  assert.ok(Math.abs(npmExposure(daysAgo(730), NOW, 10) - 1) < 1e-9)
  assert.equal(npmExposure(daysAgo(5000), NOW, 10), 1, 'none past two years')
  const month = npmExposure(daysAgo(30), NOW, 10), year = npmExposure(daysAgo(365), NOW, 10)
  assert.ok(month > 0.15 && month < 0.25, `a month: ${month}`)
  assert.ok(year > 0.8 && year < 0.85, `a year: ${year}`)
  assert.deepEqual([200, 1000, 5000, 20_000, 100_000, Infinity, null].map(tier => npmExposure(daysAgo(730), NOW, tier).toFixed(2)), ['1.00', '0.95', '0.85', '0.65', '0.35', '0.10', '0.25'])
})

test('its levels, as the findings\' severities name theirs', () => {
  assert.deepEqual([0, 24, 25, 49, 50, 74, 75, 100].map(npmRiskLevel), ['low', 'low', 'moderate', 'moderate', 'high', 'high', 'critical', 'critical'])
})
