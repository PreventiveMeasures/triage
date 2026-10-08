import { parseToml } from '@preventive/lockfile/toml.js'
import { reportRepoGithub } from '@preventive/report'
import { bundleCommitHash } from '../../common/bundle-commit.js'
import { packageRepo } from './package-repo.js'

function readManifest(files, name) {
  const text = files?.[name]
  if (typeof text !== 'string') return null
  // JSON as Node reads a package.json: past a byte order mark a bundle keeps.
  try { return name.endsWith('.toml') ? parseToml(text) : JSON.parse(text.replace(/^\uFEFF/u, '')) } catch { return null }
}

function githubRepository(value) {
  const url = typeof value === 'string' ? value : value?.url
  if (typeof url !== 'string') return null
  const github = url.trim().replace(/#.*$/su, '')
    .replace(/^github:/iu, '')
    .replace(/^git\+/iu, '')
    .replace(/^(?:ssh|git):\/\/(?:git@)?github\.com\//iu, 'https://github.com/')
    .replace(/^git@github\.com:/iu, 'https://github.com/')
  if (!/^(?:https?:\/\/)?(?:www\.)?github\.com\//iu.test(github)) return null
  return reportRepoGithub({ repo: { github } })
}

// Read only captured package metadata; never fetch a registry on hover or
// borrow the application's repository for one of its dependencies. Stasis
// records a dependency's own repository on its module; for a bundle from
// before it did, a captured package.json is read by the rule Stasis records
// one by. Composer and Cargo manifests name theirs in other fields. Only a
// recorded repository carries the commit the package was captured at.
export function bundleSourcePackageInfo(pkg, info, fileCount) {
  const ecosystem = info?.ecosystem ?? pkg.ecosystem ?? 'npm'
  const manifest = ecosystem === 'composer'
    ? readManifest(info?.files, 'composer.json')
    : ecosystem === 'cargo'
      ? readManifest(info?.files, 'Cargo.toml')?.package
      : readManifest(info?.files, 'package.json')
  const name = info?.name ?? pkg.name
  const version = info?.version ?? pkg.version ?? manifest?.version
  const recorded = reportRepoGithub(info)
  const repo = recorded ? { github: recorded, directory: info.repo.directory }
    : ecosystem === 'npm' || ecosystem === 'soldeer' ? packageRepo(manifest)
      : { github: [manifest?.repository, manifest?.support?.source, manifest?.source?.url, manifest?.homepage, manifest?.bugs]
        .map(value => githubRepository(value)).find(Boolean) }
  const directory = typeof repo?.directory === 'string' ? repo.directory : undefined
  const commit = recorded ? bundleCommitHash(info.repo.commit) : null
  return { ecosystem, name, version: typeof version === 'string' ? version : undefined, github: repo?.github ?? null, ...(directory === undefined ? {} : { directory }), ...(commit ? { commit } : {}), fileCount }
}
