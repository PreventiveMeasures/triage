export const REVIEW_VERDICTS = {
  accept: 'Accept',
  'accept-with-nits': 'Accept with nits (non-blocking)',
  'request-changes': 'Request changes',
  reject: 'Reject',
}

// Publication saves the exact changed paths. Only per-file verdicts check
// files; the strongest one limits how favorable the final verdict can be.
export function summarizeReview(entries, files) {
  const verdicts = Object.keys(REVIEW_VERDICTS)
  const checks = entries.filter(entry => entry.file !== null && verdicts.includes(entry.status))
  const verdictLimit = verdicts.findLast(verdict => checks.some(entry => entry.status === verdict)) ?? 'accept'
  if (files === null) return { coverage: null, checkedFiles: null, totalFiles: null, verdictLimit }
  const checked = new Set(checks.map(entry => entry.file))
  const checkedFiles = files.filter(file => checked.has(file)).length
  return { coverage: checkedFiles === files.length ? 'full' : 'partial', checkedFiles, totalFiles: files.length, verdictLimit }
}

export function allowedReviewVerdicts(entries, limit = 'accept') {
  const verdicts = Object.keys(REVIEW_VERDICTS)
  return verdicts.slice(Math.max(verdicts.indexOf(limit), verdicts.indexOf(summarizeReview(entries, null).verdictLimit)))
}

// npm's security placeholder, identified by its provenance as well as its name.
export function npmTakenDown({ npm: { version, manifest = {} } }) {
  const npms = manifest.description === 'security holding package' || manifest.github?.github?.toLowerCase() === 'npm/security-holder'
  return npms && (manifest.publisher === 'npm' || /-security(?:\.\d+)?$/u.test(version))
}

// Only findings affecting the version being reviewed constrain its verdict.
// Socket's aggregate scores also fall for other reasons; use explicit alerts.
// Alert identifiers: https://docs.socket.dev/docs/rule-conditions
export function npmReviewVerdictLimit(npm, advisoryList, socket) {
  if (!npm) return 'accept'
  const index = advisoryList?.versions?.indexOf(npm.version) ?? -1
  const advisories = index < 0 ? [] : advisoryList.advisories.filter(advisory => advisory.affected.includes(index))
  const alerts = npm.private ? [] : socket?.alerts ?? []
  if (npmTakenDown({ npm }) || alerts.some(alert => alert.type === 'malware')
    || advisories.some(advisory => advisory.id?.startsWith('MAL-') || /^Malicious package\b/iu.test(advisory.title ?? ''))) return 'reject'
  if (advisories.some(advisory => advisory.severity === 'critical') || alerts.some(alert => alert.type === 'criticalCVE')) return 'request-changes'
  return 'accept'
}

export function needsPackageJsonReview(entries, files) {
  return summarizeReview(entries, files).coverage === 'partial'
    && !entries.some(entry => entry.file === 'package.json' && Object.keys(REVIEW_VERDICTS).includes(entry.status))
}

const markdownText = text => text.replaceAll(/[\\`*_{}[\]<>]/gu, '\\$&').replaceAll(/\r\n?/gu, '\n').replaceAll('\n', '\n  ')

export function parseReviewNotes(comment) {
  return comment.replaceAll(/\r\n?/gu, '\n').split(/(?:^|\n)[\t ]*\*[\t ]+/u)
    .map((text, index) => ({ text: text.trim(), bullet: index > 0 })).filter(note => note.text)
}

function auditNotes(comment, file = null) {
  const prefix = file === null ? '' : `In ${markdownText(file)}: `
  return parseReviewNotes(comment).map(note => `* ${prefix}${markdownText(note.text)}`)
}

export function auditMarkdown(review) {
  if (review.publishedAt === null || review.revokedAt !== null || review.coverage !== 'full'
    || !['accept', 'accept-with-nits'].includes(review.status)) return null
  const target = `${review.package} ${review.version} ${review.integrity}`
  const dependency = review.basePackage === null ? target
    : review.basePackage === review.package ? `${review.package} ${review.baseVersion} -> ${review.version} ${review.integrity}`
    : `${review.basePackage} ${review.baseVersion} -> ${target}`
  const notes = [...review.entries.flatMap(entry => auditNotes(entry.comment, entry.file)), ...auditNotes(review.comment)]
  return `Audited:\n\`\`\`\n${dependency}\n\`\`\`${notes.length > 0 ? `\n\nNotes:\n${notes.join('\n')}` : ''}`
}
