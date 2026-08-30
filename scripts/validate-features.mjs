#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const checklist = JSON.parse(await readFile(resolve(root, 'checklist.json'), 'utf8'))
const expectedStatuses = ['todo', 'doing', 'review', 'done', 'blocked', 'dropped']
const statuses = new Set(expectedStatuses)
const findings = []
const counts = Object.fromEntries([...statuses].map((status) => [status, 0]))

const legendStatuses = new Set(Object.keys(checklist.statusLegend ?? {}))
for (const status of expectedStatuses) {
  if (!legendStatuses.has(status)) findings.push(`statusLegend is missing ${status}`)
}
for (const status of legendStatuses) {
  if (!statuses.has(status)) findings.push(`statusLegend has unsupported status ${status}`)
}

function rollupStatus(features) {
  const active = features.filter((feature) => feature.status !== 'dropped')
  if (active.length === 0) return 'dropped'
  if (active.some((feature) => feature.status === 'blocked')) return 'blocked'
  if (active.some((feature) => feature.status === 'doing')) return 'doing'
  if (active.some((feature) => feature.status === 'todo')) return 'todo'
  if (active.some((feature) => feature.status === 'review')) return 'review'
  return 'done'
}

for (const feature of checklist.features ?? []) {
  if (!statuses.has(feature.status)) {
    findings.push(`${String(feature.id)} has invalid status ${String(feature.status)}`)
    continue
  }
  counts[feature.status] += 1
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(feature.updatedAt ?? '')) {
    findings.push(`${String(feature.id)} has invalid updatedAt`)
  }
  if (
    (feature.status === 'review' || feature.status === 'done' || feature.status === 'blocked') &&
    (!Array.isArray(feature.notes) || feature.notes.length === 0)
  ) {
    findings.push(`${String(feature.id)} status ${feature.status} requires evidence in notes`)
  }
}

for (const requirement of checklist.requirements ?? []) {
  if (!statuses.has(requirement.status)) {
    findings.push(`${String(requirement.id)} has invalid status ${String(requirement.status)}`)
    continue
  }
  const features = (checklist.features ?? []).filter(
    (feature) => feature.requirement === requirement.id,
  )
  if (features.length === 0) continue
  const expected = rollupStatus(features)
  if (requirement.status !== expected) {
    findings.push(
      `${String(requirement.id)} status ${String(requirement.status)} does not match feature rollup ${expected}`,
    )
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`- ${finding}`)
  process.exitCode = 1
} else {
  console.log(`Feature ledger valid: ${JSON.stringify(counts)}`)
}
