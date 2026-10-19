// The code viewer's Activity views' own bundle (ui/activity.js): a
// repository's Commits, Issues, Pull requests, Agents, Pulse and Replay
// (repository-activity.js), out of view.js until one of them opens.
import { prefetchActivity } from './client-managed.js'
import { lazyTemplate } from './lazy-template.js'
import { activitySubtab, pulseWeeks } from './repository-activity.js'

// `template()` once the bundle is here, a placeholder until then
// (lazy-template.js).
export const withRepositoryActivity = lazyTemplate('./activity.js')

// The first read view `tab` of repository `repoId` makes, in the sub-tab it
// shows, asked for while the bundle loads (prefetchActivity): as its route
// opens (repository-code.js), or it shows, as the strip's tab switches to
// it; none once the bundle is here, its views reading as they open.
export function prefetchActivityView(repoId, tab) {
  if (withRepositoryActivity.loaded()) return
  void prefetchActivity(repoId, tab, { state: activitySubtab(tab) === 'closed' ? 'closed' : 'open', weeks: pulseWeeks() })
}
