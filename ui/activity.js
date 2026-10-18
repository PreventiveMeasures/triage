// Activity: the code viewer's views of what happens around a repository's
// code (view/repository-activity.js), its commits (`<repository-history>`),
// issues and pull requests (`<repository-issues>`), agents' sessions
// (`<repository-agents>`), pulse (`<repository-pulse>`) and replay
// (`<repository-replay>`). An esbuild entry point of its own:
// `view/activity-load.js` imports it by a runtime string the first time one
// of them opens, so view.js doesn't carry them. Built with view.js, it takes
// lit and the client state from the same chunks, and so the same instances.
import './view/repository-history.js'
import './view/repository-agents.js'
import './view/repository-pulse.js'
import './view/repository-replay.js'
import './view/repository-issues.js'
