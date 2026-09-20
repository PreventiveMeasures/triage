// FROZEN. The id fingerprint of a Piolium finding's LOCATION.
//
// A finding's uuid (finding-id.js) is the key every piece of stored
// triage hangs off, so it has to be a function of the source document
// alone, and it has to stay that function. The reference reader in
// md-structure.js is not that: `parseCodeRef` is what the card shows a
// finding's file, line and link as, and it changes when a report turns
// up that it reads wrongly — which is exactly what happened to the
// reader this one was copied from, whose link expression could not see
// a path with brackets in it (`app/(main)/[id]/page.ts`).
//
// So the fingerprint comes from a second reading of the same text, the
// one in this file: `parseCodeRef` as it stood when the ids in users'
// browsers were derived, bug and all. parse-piolium.js stamps what it
// returns onto each finding as `_idBasis`, and deriveFindingId uses it
// in place of the finding's own fields.
//
// DO NOT change the behaviour of anything in this file — not to fix
// the bug it preserves, not to share code with md-structure.js, not to
// make it read better. Every byte it emits is baked into uuids;
// report/tests/finding-id-piolium.test.js holds the golden values it
// must keep producing.
//
// What it does NOT freeze: the severity and the description, which the
// live parser hands in. Those are the same exposure they have always
// been for this format — a change to how a Piolium description is
// built still re-keys these findings, as it always would have. This
// file pins the half that was about to move.

// `parseCodeRef` (md-structure.js), as of the last commit before the
// link reading was fixed. Its own copies of the expressions, so
// nothing it depends on can drift underneath it.
function frozenCodeRef(raw) {
  let text = (raw || '').trim()
  let locationLink = ''
  const link = /\[([^\]]+)\]\(([^)]+)\)/u.exec(text)
  if (link) {
    text = link[1].trim()
    locationLink = link[2].trim()
  }
  let line = ''
  const anchor = /#L(\d+)/u.exec(locationLink)
  if (anchor) line = anchor[1]
  const spans = [...text.matchAll(/`([^`]+)`/gu)].map((m) => m[1].trim())
  const pathish = spans.find((s) => !s.includes('(') && (s.includes('/') || /\.\w/u.test(s)))
  let file = pathish ?? (text.replaceAll('`', '').trim().split(/[\s,]+/u).find(Boolean) || '')
  const frag = /^(.*?)#L(\d+)(?:-L?\d+)?$/u.exec(file)
  if (frag) {
    file = frag[1]
    if (!line) line = frag[2]
  }
  const colon = /^(.+):(\d+(?:-\d+)?)$/u.exec(file)
  if (colon) {
    if (!line) line = colon[2]
    return { file: colon[1], line, locationLink }
  }
  return { file, line: line || '?', locationLink }
}

// The fingerprint object `deriveFindingId` hashes for one finding, in
// a fixed key order (JSON.stringify keeps insertion order, so the
// order IS part of the id). The discriminator is the location when the
// reference carried a link — or the `piolium:<id>` stand-in an
// unlocated finding gets — and file / line otherwise: the same two
// branches deriveFindingId takes for a finding that carries no basis,
// which is what these findings had before this file existed.
//
// `lineBullet` is the `**Line:**` value the detail reader falls back
// to, and `id` the finding's own; an index row passes neither but its
// row id.
export function frozenIdBasis({ severity, description, ref, lineBullet = '', id = '' }) {
  const read = frozenCodeRef(ref)
  const file = read.file || 'unknown'
  const line = read.line === '?' && lineBullet ? lineBullet : read.line
  const location = read.locationLink || (file === 'unknown' && id ? `piolium:${id}` : '')
  return location
    ? { severity, description, location }
    : { severity, description, file, line }
}
