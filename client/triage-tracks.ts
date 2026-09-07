// The two triage tracks, as types. `TriageEntry` (state.ts) carries
// both and `triage-entry.ts` holds every operation over them; they sit
// here so neither of those has to own the other's definitions.
//
// WHY THERE ARE TWO. A finding's id is derived from the source's own
// bytes (report/src/finding-id.js), so the SAME id is what every app
// shipping that code reads — one dependency file, one entry, however
// many apps pull it in. That made a single "fixed" two different
// claims wearing one word: "this app doesn't have the problem any
// more" (true here, nowhere else) and "the code doesn't have the bug
// any more" (true everywhere, and only the upstream can say it).
// Writing the first into a shared entry is what marked a dependency
// fixed in apps nobody had looked at.
//
// So the work goes in `apps`, one slot per app (`findingApp` in
// ui/view/group.js names them), and the cause goes in `upstream`,
// global by id on purpose: reporting a bug once and seeing it
// everywhere is the whole point, and an entry keyed by the vulnerable
// bytes is exactly where "superseded in 4.17.21" belongs — everyone
// still shipping them reads it.
//
// `TriageEntry.triage` keeps its meaning for a finding in the app's
// OWN code, where the app IS the upstream and one verdict is the whole
// truth, and it grandfathers the unscoped values written before the
// split. Which track a write lands on and which one a board reads are
// decided in one place each: `bucketForApp` (triage-entry.ts) and
// `setTabTriage` / `tabTriage` (ui/view/group.js).

// The work states only. 'invalid' and 'deleted' are claims about the
// finding itself — that it isn't a bug, that the record shouldn't be
// kept — and those hold wherever the code is shipped, so they stay on
// the entry rather than being answered per app.
export type AppTriage = 'inprogress' | 'fixed'

// One app's answer about one finding, with that app's own fix
// reference (the PR that removed the dependency) as distinct from the
// entry's cause-level `fix`.
export type AppEntry = {
  triage?: AppTriage
  fix?: string
}

// What the upstream has done about the cause. `since` names the first
// version carrying the fix, which is what turns another app's copy of
// this finding from "no known remedy" into "upgrade to 4.17.21".
export type UpstreamState = 'reported' | 'fixed' | 'wontfix'
export type UpstreamEntry = {
  state?: UpstreamState
  link?: string
  since?: string
}
