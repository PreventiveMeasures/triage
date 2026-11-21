// The Activity views' own bundle (ui/activity.js), out of view.js until one
// opens (repository-activity.js).
import { prefetchActivity } from './client-managed.js'
import { lazyTemplate } from './lazy-template.js'
import { activitySubtab, pulseWeeks } from './repository-activity.js'

// `template()` once the bundle is here, a placeholder till then.
export const withRepositoryActivity = lazyTemplate('./activity.js')

// The first read view `tab` of repository `repoId` makes, in its sub-tab,
// asked for while the bundle loads (as its route opens, or the strip
// switches to it); none once the bundle is here.
export function prefetchActivityView(repoId, tab) {
  if (withRepositoryActivity.loaded()) return
  void prefetchActivity(repoId, tab, { state: activitySubtab(tab) === 'closed' ? 'closed' : 'open', weeks: pulseWeeks() })
}
