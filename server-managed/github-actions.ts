// What a repository risk scan resolves actions with (actions-scan
// ActionsSource): GitHub, read with a token, an admin's own as browsing a
// repository is, or none for public repositories alone. @preventive/upstream's
// client asks for a repository, followed where it was renamed or transferred,
// its tags, a tag's commit, a branch's head and a file at a commit, each
// held to what was asked; GitHub's compare API tells whether a commit is in a
// branch's or a commit's history, and its branches' first page is listed.
// What GitHub has none of reads as none; anything else is thrown as a
// GithubApiError.
import { createClient } from '@preventive/upstream/github.js'
import type { ActionsSource } from '../risk/index.js'
import { GithubApiError, upstreamGithub } from './github-errors.ts'
import { githubJson } from './github-app.ts'

// How many pages of 100 tags are listed; a repository with more is told by
// its tags one at a time.
const MAX_TAG_PAGES = 10
const BRANCHES_PAGE = 100

const api = (name: string, suffix: string) => `https://api.github.com/repos/${name.split('/').map(encodeURIComponent).join('/')}${suffix}`

// Whether upstream refused what it was asked before asking GitHub, as a ref
// git wouldn't take: its arguments' checks say what each must be.
const isRefused = (error: unknown) => error instanceof Error && error.name === 'AssertionError' && / must be /u.test(error.message)

// What `read` answers, null where GitHub has none (a 404), or upstream
// refused to ask.
async function orNone<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await upstreamGithub(() => read().catch((error: unknown) => { throw isRefused(error) ? new GithubApiError(404, 'github-not-found') : error }))
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) return null
    throw error
  }
}

interface RepoObject { full_name?: unknown; default_branch?: unknown; fork?: unknown; parent?: { full_name?: unknown }; archived?: unknown; private?: unknown }

export function githubActionsSource(token: string | null, fetchImpl: typeof fetch = globalThis.fetch): ActionsSource {
  const client = createClient({ token })
  return {
    async repo(name) {
      const info = await orNone(() => client.getRepo({ repo: name, followRedirect: true })) as RepoObject | null
      if (!info) return null
      if (typeof info.full_name !== 'string' || typeof info.default_branch !== 'string') throw new GithubApiError(502, 'github-malformed')
      return { fullName: info.full_name, defaultBranch: info.default_branch, archived: info.archived === true, private: info.private !== false,
        fork: info.fork === true ? (typeof info.parent?.full_name === 'string' ? info.parent.full_name : '') : null }
    },
    tags(name) {
      // More than MAX_TAG_PAGES pages, which upstream refuses to list whole.
      return upstreamGithub(() => client.listRepoTags({ repo: name, maxPages: MAX_TAG_PAGES })
        .catch((error: unknown) => { if (error instanceof Error && /more than \d+ pages/u.test(error.message)) return null; throw error }))
    },
    tag: async (name, tag) => (await orNone(() => client.getRepoTag({ repo: name, tag })))?.oid ?? null,
    branch: async (name, branch) => (await orNone(() => client.getRepoHead({ repo: name, branch })))?.oid ?? null,
    async branches(name) {
      const listed = await githubJson(api(name, `/branches?per_page=${BRANCHES_PAGE}`), token, fetchImpl)
      if (!Array.isArray(listed)) throw new GithubApiError(502, 'github-malformed')
      const branches = (listed as { name?: unknown; commit?: { sha?: unknown } }[]).flatMap(item => typeof item?.name === 'string'
        && typeof item.commit?.sha === 'string' && /^[\da-f]{40}$/u.test(item.commit.sha) ? [{ branch: item.name, oid: item.commit.sha }] : [])
      return { branches, complete: listed.length < BRANCHES_PAGE }
    },
    // `base...sha`: `sha` is `base` or in its history where GitHub tells it
    // behind or identical, a commit of a fork in the same network too.
    async contains(name, base, sha) {
      if (!/^[\da-f]{40}$/u.test(sha)) return null
      let compared
      try { compared = await githubJson(api(name, `/compare/${base.split('/').map(encodeURIComponent).join('/')}...${sha}?per_page=1`), token, fetchImpl) as { status?: unknown } } catch (error) {
        if (error instanceof GithubApiError && (error.status === 404 || error.message === 'github-status-422')) return null
        throw error
      }
      if (typeof compared?.status !== 'string') throw new GithubApiError(502, 'github-malformed')
      return compared.status === 'behind' || compared.status === 'identical'
    },
    file: (name, path, commit) => orNone(() => client.getRepoFile({ repo: name, path, ref: commit })),
  }
}
