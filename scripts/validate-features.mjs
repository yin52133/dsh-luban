#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const checklist = JSON.parse(await readFile(resolve(root, 'checklist.json'), 'utf8'))
const statuses = new Set(['todo', 'doing', 'review', 'done', 'blocked', 'dropped'])
const findings = []
const counts = Object.fromEntries([...statuses].map((status) => [status, 0]))

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
  const features = (checklist.features ?? []).filter(
    (feature) => feature.requirement === requirement.id && feature.status !== 'dropped',
  )
  if (features.length === 0) continue
  const allDone = features.every((feature) => feature.status === 'done')
  const allReviewable = features.every(
    (feature) => feature.status === 'review' || feature.status === 'done',
  )
  if (requirement.status === 'done' && !allDone) {
    findings.push(`${String(requirement.id)} is done before every feature is done`)
  }
  if (requirement.status === 'review' && !allReviewable) {
    findings.push(`${String(requirement.id)} is review before every feature is reviewable`)
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`- ${finding}`)
  process.exitCode = 1
} else {
  console.log(`Feature ledger valid: ${JSON.stringify(counts)}`)
}
