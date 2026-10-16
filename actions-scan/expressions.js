// What of a workflow's expressions (`${{ … }}`) anyone can write: a pull
// request's, an issue's or a comment's title and body, a branch's name, a
// commit's message and author, as whoever opens or pushes one picks them.
// Written into a script (`run:`, github-script's `script:`), the expression
// is replaced before the script runs, so what it holds runs as the script's
// own code: `"${{ github.event.issue.title }}"` runs whatever a title closes
// the quote and adds. Read through an environment variable, it is data.

// The events a workflow runs on with the base repository's secrets and a
// token that can write, for a pull request from a fork, an issue or a
// comment anyone can open.
export const PRIVILEGED_TRIGGERS = new Set(['pull_request_target', 'workflow_run', 'issue_comment', 'issues', 'discussion', 'discussion_comment',
  'pull_request_review', 'pull_request_review_comment', 'fork', 'watch'])

// An index, as an expression names one of a list: `[0]`, `[*]`, `.*`.
const INDEX = String.raw`(?:\s*\[[^\]]*\]|\.\*)`
const AUTHOR = String.raw`(?:author|committer)\.(?:email|name)`
const UNTRUSTED = new RegExp(String.raw`\bgithub\s*\.\s*(?:head_ref|event\s*\.\s*(?:`
  + [String.raw`issue\.(?:title|body)`,
    String.raw`pull_request\.(?:title|body|head\.(?:ref|label|repo\.default_branch))`,
    String.raw`(?:comment|review|review_comment)\.body`,
    String.raw`pages${INDEX}\.page_name`,
    String.raw`commits${INDEX}\.(?:message|${AUTHOR})`,
    String.raw`head_commit\.(?:message|${AUTHOR})`,
    String.raw`workflow_run\.(?:head_branch|display_title|head_commit\.(?:message|${AUTHOR})|pull_requests${INDEX}\.head\.ref)`,
    String.raw`discussion\.(?:title|body)`].join('|')
  + String.raw`))(?![\w-])`, 'gu')

// The expressions anyone can write in `text`, each `{ expression, index }`:
// its context's path as written, and where in `text` its `${{` is.
export function untrustedExpressions(text) {
  if (typeof text !== 'string' || !text.includes('${{')) return []
  const found = []
  for (const { 0: whole, 1: inner, index } of text.matchAll(/\$\{\{([\s\S]*?)\}\}/gu)) {
    for (const { 0: expression } of inner.matchAll(UNTRUSTED)) found.push({ expression: expression.replaceAll(/\s+/gu, ''), index, length: whole.length })
  }
  return found
}

// A ref naming a pull request's own code, as `actions/checkout`'s `ref:`
// would check it out: its head's sha or branch, `refs/pull/…`, or a
// workflow run's head.
const PULL_HEAD = /\bgithub\s*\.\s*(?:head_ref|event\s*\.\s*(?:pull_request\s*\.\s*head\s*\.\s*(?:sha|ref)|workflow_run\s*\.\s*head_(?:sha|branch)|number|pull_request\s*\.\s*number))\b|refs\/pull\//u
export const namesPullHead = text => typeof text === 'string' && PULL_HEAD.test(text)
