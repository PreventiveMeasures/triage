import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OTHER_REPOSITORIES, repositoryChoices, repositoryParts } from '../ui/view/repository-options.js'
import { userChoices, userOptions } from '../ui/view/user-options.js'

const optionsFor = names => names.map((label, value) => ({ value, label, detail: `${value} bundles`, special: label === 'Unattached' }))

test('repository layout handles one organization, scattered repositories, and mixtures without losing choices', () => {
  for (const names of [
    Array.from({ length: 100 }, (_, i) => `acme/repo-${i}`),
    Array.from({ length: 100 }, (_, i) => `owner-${i}/repo`),
    [...Array.from({ length: 60 }, (_, i) => `acme/repo-${i}`), ...Array.from({ length: 30 }, (_, i) => `other-${i}/repo`), 'small/a', 'small/b', 'Unattached'],
  ]) {
    const options = optionsFor(names)
    const choices = repositoryChoices(options)
    assert.deepEqual(new Set([...choices.pinned, ...choices.sections.flatMap(section => section.options)].map(option => option.value)), new Set(options.map(option => option.value)))
    assert.equal(choices.count, options.length)
    assert.ok(choices.sections.filter(section => section.label).every(section => section.options.length > 1))
    assert.equal(choices.showFacets, names.includes('small/a'))
  }
})

test('search matches owner and repository tokens; organization filtering preserves IDs and counts', () => {
  const options = optionsFor(['acme/api', 'acme/web', 'other/api', 'Unattached'])
  const result = repositoryChoices(options, 'ACME api')
  assert.deepEqual(result.sections[0].options.map(option => [option.value, option.detail]), [[0, '0 bundles']])
  assert.equal(repositoryChoices(options, 'api', OTHER_REPOSITORIES).count, 1)
  assert.equal(repositoryChoices(options, 'missing').count, 0)
  assert.equal(repositoryChoices(options, '', 'removed-owner').count, 4)
  assert.equal(repositoryChoices(options, 'unattached').pinned[0].value, 3)
})

test('Other combines singleton organizations and separates their full names from named groups', () => {
  const options = optionsFor(['redis/ioredis', 'redis/node-redis', 'adjust/react_native_sdk', 'anza-xyz/kit', 'Other/one', 'Other/two', 'Unattached'])
  const result = repositoryChoices(options)
  assert.deepEqual(result.facets.map(group => [group.name, group.count]), [['Other', 2], ['redis', 2], ['Other', 2]])
  const others = repositoryChoices(options, '', OTHER_REPOSITORIES)
  assert.equal(others.sections[0].label, 'Other')
  assert.equal(others.sections[0].organization, false)
  assert.deepEqual(others.sections[0].options.map(option => option.label), ['adjust/react_native_sdk', 'anza-xyz/kit'])
  assert.deepEqual(others.pinned.map(option => option.label), ['Unattached'])
  assert.deepEqual(repositoryChoices(options, '', 'Other').sections[0].options.map(option => option.label), ['Other/one', 'Other/two'])
  assert.equal(repositoryChoices(options, 'anza', OTHER_REPOSITORIES).count, 1)
})

test('reset and unattached choices remain distinct from repository identifiers', () => {
  const options = [
    { value: '', label: 'All repositories', special: true, reset: true },
    { value: '\u0001', label: '(no repo)', special: true },
    { value: null, label: 'No repository', special: true },
    { value: 'https://github.com/acme/repo', label: 'acme/repo' },
  ]
  const result = repositoryChoices(options, 'acme')
  assert.deepEqual(result.pinned.map(option => option.value), [''])
  assert.equal(result.sections[0].options[0].value, 'https://github.com/acme/repo')
  assert.equal(result.total, 3)
  assert.equal(repositoryChoices(options, 'no repo').count, 2)
  assert.deepEqual(repositoryChoices([]).sections, [])
})

test('repository grouping retains nested paths and distinguishes hosts', () => {
  assert.deepEqual(repositoryParts('acme/monorepo/packages/api'), { owner: 'acme', name: 'monorepo/packages/api' })
  assert.deepEqual(repositoryParts('https://code.example/acme/repo'), { owner: 'code.example/acme', name: 'repo' })
  assert.deepEqual(repositoryParts('https://other.example/acme/repo'), { owner: 'other.example/acme', name: 'repo' })
  assert.equal(repositoryParts('https://bad host/repo').owner, null)
})

test('user search matches names and logins while preserving membership and opaque IDs', () => {
  const options = userOptions([{ id: 'one', name: 'Alex Security', login: 'asec' }, { id: 2, name: null, login: 'reviewer', disabled: true, detail: 'Member' }])
  assert.equal(userChoices(options, 'alex ASEC').sections[0].options[0].value, 'one')
  assert.equal(userChoices(options, '@reviewer').sections[0].options[0].disabled, true)
  assert.equal(options[0].initials, 'AS')
  assert.equal(options[1].label, '@reviewer')
  assert.equal(userChoices(options, 'unknown').count, 0)
  const reset = { value: '', label: 'All users', reset: true }
  const filtered = userChoices([reset, ...options], 'reviewer')
  assert.deepEqual(filtered.pinned, [reset], 'reset stays available while searching')
  assert.equal(filtered.count, 1)
  assert.equal(filtered.total, 2, 'reset is not a user')
})
