// The code viewer's Activity views' own bundle (ui/activity.js): a
// repository's Commits, Issues, Pull requests, Agents, Pulse and Replay
// (repository-activity.js), out of view.js until one of them opens.
import { lazyTemplate } from './lazy-template.js'

// `template()` once the bundle is here, a placeholder until then
// (lazy-template.js).
export const withRepositoryActivity = lazyTemplate('./activity.js')
