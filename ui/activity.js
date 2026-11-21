// The code viewer's activity views (view/repository-activity.js): history,
// issues and pull requests, agents, pulse and replay. An esbuild entry that
// view/activity-load.js imports by a runtime string on first use, so view.js
// doesn't carry them; built with view.js, it shares its lit and client state.
import './view/repository-history.js'
import './view/repository-agents.js'
import './view/repository-pulse.js'
import './view/repository-replay.js'
import './view/repository-issues.js'
