import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptsReportMetadata } from '../server-managed/report-response.ts'

test('report metadata accepts explicit JSON media ranges and positive quality values', () => {
  for (const accept of [
    'application/json', 'application/json, */*', 'application/json; q=1',
    'text/plain, APPLICATION/JSON; Q=0.5', 'application/json; charset=utf-8; q=0.001',
    'application/json; profile="a,b"; q=1',
  ]) assert.equal(acceptsReportMetadata(accept), true, accept)
})

test('report metadata is not selected by wildcards, excluded JSON, or malformed qualities', () => {
  for (const accept of [
    undefined, '', '*/*', 'application/*', 'text/plain', 'application/jsonp',
    'application/json; q=0, */*', 'application/json; q=0.000',
    'application/json; q=garbage', 'application/json; q=2', 'application/json; q=-1',
    'application/json; profile="a,b"; q=0', 'text/plain; profile="application/json"',
  ]) assert.equal(acceptsReportMetadata(accept), false, String(accept))
})
