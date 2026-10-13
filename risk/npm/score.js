// A version's risk as one number, out of 100: what its findings call for,
// lowered by how long it has been out among how many who would have noticed.
// Its findings stay what a reviewer reads; the score orders what to read
// first.
import { DAY_MS } from './downloads.js'

// How much each finding raises the score, by its severity: a version's
// findings combined as independent chances are (1 − Π(1 − weight)), so that
// each adds less the more there are, none past 100. One red finding alone is
// 50; two, or one with two orange, past 75, as attacks show.
const WEIGHTS = { critical: 0.5, high: 0.2, moderate: 0.08, low: 0.03, notice: 0 }
// What the version's age tells instead (`too-new`), as exposure does below.
const TOLD_BY_AGE = new Set(['too-new'])

// How much a version's exposure lowers the score, at most: a version out for
// years among millions keeps a tenth of what its findings call for, as an
// attack that long among that many would have been found and pulled.
const MOST_LOWERED = 0.9
// From how old a version is lowered at all, and how old fully: two weeks, as
// risk's minimum release age (release.js), and two years, on a log scale.
const EXPOSED_FROM_DAYS = 14
const EXPOSED_DAYS = 730
// How much who downloads a package lowers it, by its tier (downloads.js): its
// rank by downloads. The top 200 fully; one few download hardly, as few would
// notice; one whose downloads aren't known (null, a caller's own package, or
// one npm counts none of) a little.
const TIER_EXPOSURE = [[200, 1], [1000, 0.95], [5000, 0.85], [20_000, 0.65], [100_000, 0.35], [Infinity, 0.1]]
const UNKNOWN_TIER_EXPOSURE = 0.25

// The score's levels, as the findings' severities name theirs.
const LEVELS = [[75, 'critical'], [50, 'high'], [25, 'moderate'], [0, 'low']]
export const npmRiskLevel = score => LEVELS.find(([from]) => score >= from)[1]

// How exposed a version has been, from 0 to 1: how long it has been out
// (`published` an ISO time, at `now`) times how widely its package is
// downloaded (`tier`, null where unknown).
export function npmExposure(published, now, tier) {
  const days = typeof published === 'string' ? (now - Date.parse(published)) / DAY_MS : NaN
  if (!(days > EXPOSED_FROM_DAYS)) return 0
  const age = Math.min(1, Math.log(days / EXPOSED_FROM_DAYS) / Math.log(EXPOSED_DAYS / EXPOSED_FROM_DAYS))
  const wide = tier === null ? UNKNOWN_TIER_EXPOSURE : TIER_EXPOSURE.find(([upTo]) => tier <= upTo)[1]
  return age * wide
}

// A version's risk score (`score`, 0 to 100) and its `level`, from its
// assessment's `findings` and its exposure (npmExposure): 100 where malware
// is told of it, however old; else what its findings call for (`raised`, each
// `{ id, severity }` it counts), lowered by its exposure (`lowered`: its
// `days` out, its `tier`, and by how much, a share), none lowered under two
// weeks.
export function npmRiskScore(findings, { published = null, now = Date.now(), tier = null } = {}) {
  if (findings.some(({ id }) => id === 'malware')) return { score: 100, level: 'critical', raised: [{ id: 'malware', severity: 'critical' }] }
  const raised = findings.filter(({ id, severity }) => !TOLD_BY_AGE.has(id) && WEIGHTS[severity] > 0).map(({ id, severity }) => ({ id, severity }))
  const called = 1 - raised.reduce((left, { severity }) => left * (1 - WEIGHTS[severity]), 1)
  const exposure = npmExposure(published, now, tier)
  const score = Math.round(100 * called * (1 - MOST_LOWERED * exposure))
  return { score, level: npmRiskLevel(score), raised,
    ...exposure > 0 ? { lowered: { days: Math.floor((now - Date.parse(published)) / DAY_MS), tier: Number.isFinite(tier) ? tier : null, by: Math.round(100 * MOST_LOWERED * exposure) / 100 } } : {} }
}
