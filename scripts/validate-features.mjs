#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const STATUS_ROLLUP_PRIORITY = Object.freeze(['blocked', 'doing', 'todo', 'review', 'done'])
export const CHECKLIST_STATUSES = Object.freeze([...STATUS_ROLLUP_PRIORITY, 'dropped'])

const statusSet = new Set(CHECKLIST_STATUSES)

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function statusCounts() {
  return Object.fromEntries(CHECKLIST_STATUSES.map((status) => [status, 0]))
}

function display(value) {
  return typeof value === 'string' ? `"${value}"` : String(value)
}

function deriveRollupStatus(features) {
  if (features.length === 0) return null
  if (features.some((feature) => !statusSet.has(feature.status))) return null

  const activeStatuses = new Set(
    features.filter((feature) => feature.status !== 'dropped').map((feature) => feature.status),
  )
  if (activeStatuses.size === 0) return 'dropped'
  return STATUS_ROLLUP_PRIORITY.find((status) => activeStatuses.has(status)) ?? null
}

function summarizeFeatures(features) {
  const counts = statusCounts()
  for (const feature of features) {
    if (statusSet.has(feature.status)) counts[feature.status] += 1
  }
  return {
    status: deriveRollupStatus(features),
    featureCount: features.length,
    counts,
  }
}

/**
 * Validate checklist status semantics and derive requirement/milestone rollups.
 * The input is never mutated.
 */
export function validateFeatureLedger(checklist) {
  const findings = []
  const features = Array.isArray(checklist?.features) ? checklist.features : []
  const requirements = Array.isArray(checklist?.requirements) ? checklist.requirements : []
  const milestones = Array.isArray(checklist?.milestones) ? checklist.milestones : []
  const featureCounts = statusCounts()

  const legend = isRecord(checklist?.statusLegend) ? checklist.statusLegend : null
  if (legend === null) findings.push('statusLegend must be an object')
  const legendStatuses = new Set(legend === null ? [] : Object.keys(legend))

  for (const status of CHECKLIST_STATUSES) {
    if (!legendStatuses.has(status))
      findings.push(`statusLegend is missing required status "${status}"`)
  }
  for (const status of legendStatuses) {
    if (!statusSet.has(status)) findings.push(`statusLegend has unsupported status "${status}"`)
    if (typeof legend[status] !== 'string' || legend[status].trim() === '') {
      findings.push(`statusLegend.${status} must be a non-empty string`)
    }
  }

  const featuresById = new Map()
  const featuresByRequirement = new Map()
  for (const feature of features) {
    const id = String(feature?.id)
    if (featuresById.has(feature?.id)) findings.push(`feature ${id} is declared more than once`)
    else featuresById.set(feature?.id, feature)

    const requirementFeatures = featuresByRequirement.get(feature?.requirement) ?? []
    requirementFeatures.push(feature)
    featuresByRequirement.set(feature?.requirement, requirementFeatures)

    if (!legendStatuses.has(feature?.status)) {
      findings.push(
        `feature ${id} status ${display(feature?.status)} is not defined in statusLegend`,
      )
    } else if (!statusSet.has(feature.status)) {
      findings.push(`feature ${id} uses unsupported schema status ${display(feature.status)}`)
    } else {
      featureCounts[feature.status] += 1
    }

    if (!/^\d{4}-\d{2}-\d{2}$/u.test(feature?.updatedAt ?? '')) {
      findings.push(`feature ${id} has invalid updatedAt`)
    }
    if (
      (feature?.status === 'review' ||
        feature?.status === 'done' ||
        feature?.status === 'blocked') &&
      (!Array.isArray(feature?.notes) || feature.notes.length === 0)
    ) {
      findings.push(`feature ${id} status ${feature.status} requires evidence in notes`)
    }
  }

  const requirementRollups = []
  const requirementIds = new Set()
  for (const requirement of requirements) {
    const id = String(requirement?.id)
    if (requirementIds.has(requirement?.id))
      findings.push(`requirement ${id} is declared more than once`)
    requirementIds.add(requirement?.id)

    if (!legendStatuses.has(requirement?.status)) {
      findings.push(
        `requirement ${id} status ${display(requirement?.status)} is not defined in statusLegend`,
      )
    } else if (!statusSet.has(requirement.status)) {
      findings.push(
        `requirement ${id} uses unsupported schema status ${display(requirement.status)}`,
      )
    }

    const directFeatures = featuresByRequirement.get(requirement?.id) ?? []
    const summary = summarizeFeatures(directFeatures)
    requirementRollups.push({ id: requirement?.id, ...summary })
    if (directFeatures.length === 0) {
      findings.push(
        `requirement ${id} has no directly associated features; status cannot be derived`,
      )
    } else if (summary.status === null) {
      findings.push(
        `requirement ${id} status cannot be derived because a feature status is invalid`,
      )
    } else if (requirement?.status !== summary.status) {
      findings.push(
        `requirement ${id} status ${display(requirement?.status)} does not match direct feature rollup "${summary.status}" (priority: blocked > doing > todo > review > done; all dropped => dropped)`,
      )
    }
  }

  for (const feature of features) {
    if (!requirementIds.has(feature?.requirement)) {
      findings.push(
        `feature ${String(feature?.id)} references unknown requirement ${display(feature?.requirement)}`,
      )
    }
  }

  const milestoneIds = new Set()
  for (const milestone of milestones) {
    const id = String(milestone?.id)
    if (milestoneIds.has(milestone?.id)) findings.push(`milestone ${id} is declared more than once`)
    milestoneIds.add(milestone?.id)
    if (Object.prototype.hasOwnProperty.call(milestone ?? {}, 'status')) {
      findings.push(`milestone ${id} must not persist status; derive it from featureIds`)
    }
  }

  const milestoneMemberships = new Map()
  const milestoneRollups = []
  for (const milestone of milestones) {
    const id = String(milestone?.id)
    const featureIds = Array.isArray(milestone?.featureIds) ? milestone.featureIds : []
    if (!Array.isArray(milestone?.featureIds)) {
      findings.push(`milestone ${id} featureIds must be an array`)
    }

    const seenFeatureIds = new Set()
    const listedFeatures = []
    for (const featureId of featureIds) {
      if (seenFeatureIds.has(featureId)) {
        findings.push(`milestone ${id} lists feature ${String(featureId)} more than once`)
        continue
      }
      seenFeatureIds.add(featureId)

      const memberships = milestoneMemberships.get(featureId) ?? []
      memberships.push(milestone?.id)
      milestoneMemberships.set(featureId, memberships)

      const feature = featuresById.get(featureId)
      if (feature === undefined) {
        findings.push(`milestone ${id} featureIds references unknown feature ${String(featureId)}`)
        continue
      }
      listedFeatures.push(feature)
      if (feature.milestone !== milestone?.id) {
        findings.push(
          `milestone ${id} lists feature ${String(featureId)}, but that feature declares milestone ${display(feature.milestone)}`,
        )
      }
    }

    const summary = summarizeFeatures(listedFeatures)
    milestoneRollups.push({ id: milestone?.id, ...summary })
    if (featureIds.length === 0) {
      findings.push(`milestone ${id} has no featureIds; status cannot be derived`)
    } else if (summary.status === null) {
      findings.push(`milestone ${id} status cannot be derived from its featureIds`)
    }
  }

  for (const feature of features) {
    const id = String(feature?.id)
    if (!milestoneIds.has(feature?.milestone)) {
      findings.push(`feature ${id} references unknown milestone ${display(feature?.milestone)}`)
      continue
    }
    const memberships = milestoneMemberships.get(feature?.id) ?? []
    if (!memberships.includes(feature.milestone)) {
      findings.push(
        `feature ${id} declares milestone ${display(feature.milestone)} but is missing from that milestone's featureIds`,
      )
    }
    if (memberships.length > 1) {
      findings.push(
        `feature ${id} is listed by multiple milestones: ${memberships.map(String).join(', ')}`,
      )
    }
  }

  return { findings, featureCounts, requirementRollups, milestoneRollups }
}

export function formatMilestoneRollup(rollup) {
  return `Milestone ${String(rollup.id)}: status=${rollup.status ?? 'unavailable'}; features=${rollup.featureCount}; counts=${JSON.stringify(rollup.counts)}`
}

async function main() {
  const root = resolve(import.meta.dirname, '..')
  const checklist = JSON.parse(await readFile(resolve(root, 'design/checklist.json'), 'utf8'))
  const result = validateFeatureLedger(checklist)

  for (const rollup of result.milestoneRollups) {
    console.log(formatMilestoneRollup(rollup))
  }

  if (result.findings.length > 0) {
    for (const finding of result.findings) console.error(`- ${finding}`)
    process.exitCode = 1
    return
  }
  console.log(`Feature ledger valid: ${JSON.stringify(result.featureCounts)}`)
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (entryPoint === import.meta.url) await main()
