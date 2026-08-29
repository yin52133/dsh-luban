#!/usr/bin/env node
/**
 * validate-design.mjs — design consistency gate for dsh-luban.
 *
 * Enforces the invariants documented in design/README.md and
 * design/04-interfaces/data-models.md §13 (checklist-json-v1):
 *   1. checklist.json parses and satisfies its schema invariants.
 *   2. Every design doc (except TEMPLATE) carries a version-record table.
 *   3. Feature IDs (M<NN>-F<NNN>) found in module spec tables match
 *      checklist.json features exactly (both directions).
 *   4. Requirement IDs (R<NN>) in trace-matrix.md match checklist.json.
 *   5. Milestone membership is consistent in both directions.
 *   6. Every feature's designDoc path exists on disk.
 *
 * Usage: node scripts/validate-design.mjs   (exit 0 = pass, 1 = findings)
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const DESIGN = join(ROOT, 'design')
const MODULES_DIR = join(DESIGN, '03-modules')
const TRACE = join(DESIGN, '01-overview', 'trace-matrix.md')

const problems = []
const info = []

function walkMd(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walkMd(p))
    else if (name.endsWith('.md')) out.push(p)
  }
  return out
}

// --- 1. checklist.json schema ---
let checklist
try {
  checklist = JSON.parse(readFileSync(join(ROOT, 'checklist.json'), 'utf8'))
} catch (e) {
  console.error(`FAIL: checklist.json is not valid JSON: ${e.message}`)
  process.exit(1)
}

const featureIdRe = /^[M]\d{2}-F\d{3}$/
const seenIds = new Set()
for (const f of checklist.features ?? []) {
  if (!featureIdRe.test(f.id ?? '')) problems.push(`checklist: bad feature id "${f.id}"`)
  if (seenIds.has(f.id)) problems.push(`checklist: duplicate feature id ${f.id}`)
  seenIds.add(f.id)
  if (!f.title) problems.push(`checklist: ${f.id} missing title`)
  if (!['P0', 'P1', 'P2', 'P3'].includes(f.priority))
    problems.push(`checklist: ${f.id} bad priority "${f.priority}"`)
  if (!['todo', 'doing', 'review', 'done', 'blocked', 'dropped'].includes(f.status))
    problems.push(`checklist: ${f.id} bad status "${f.status}"`)
}
const reqIds = new Set((checklist.requirements ?? []).map((r) => r.id))
const milestoneIds = new Set((checklist.milestones ?? []).map((m) => m.id))
for (const f of checklist.features ?? []) {
  if (!reqIds.has(f.requirement))
    problems.push(`checklist: ${f.id} references unknown requirement "${f.requirement}"`)
  if (!milestoneIds.has(f.milestone))
    problems.push(`checklist: ${f.id} references unknown milestone "${f.milestone}"`)
  if (f.id.slice(0, 3) !== f.module)
    problems.push(`checklist: ${f.id} module field "${f.module}" mismatches id prefix`)
}

// --- 2. version-record table in every design doc (except TEMPLATE) ---
const versionHeaderRe = /^\|\s*版本\s*\|\s*日期\s*\|\s*作者\s*\|\s*变更说明\s*\|/m
for (const file of walkMd(DESIGN)) {
  if (file.endsWith('TEMPLATE.md')) continue
  const text = readFileSync(file, 'utf8')
  if (!versionHeaderRe.test(text)) {
    problems.push(`doc: missing version-record table → ${relative(ROOT, file)}`)
  }
}

// --- 3. feature IDs in module spec tables vs checklist ---
const tableRowRe = /^\|\s*(M\d{2}-F\d{3})\s*\|/gm
const docFeatureIds = new Set()
for (const file of readdirSync(MODULES_DIR)
  .filter((n) => n.endsWith('.md'))
  .map((n) => join(MODULES_DIR, n))) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(tableRowRe)) docFeatureIds.add(m[1])
}
const checkFeatureIds = new Set((checklist.features ?? []).map((f) => f.id))
for (const id of docFeatureIds)
  if (!checkFeatureIds.has(id))
    problems.push(`ids: ${id} in module docs but missing from checklist.json`)
for (const id of checkFeatureIds)
  if (!docFeatureIds.has(id))
    problems.push(
      `ids: ${id} in checklist.json but not found in any module spec table (design/03-modules)`,
    )

// --- 4. requirement IDs in trace-matrix vs checklist ---
const traceText = existsSync(TRACE) ? readFileSync(TRACE, 'utf8') : ''
if (!traceText) problems.push('trace-matrix: file missing')
const traceReqs = new Set([...traceText.matchAll(/\bR\d{2}\b/g)].map((m) => m[0]))
const checklistReqs = new Set([...reqIds])
for (const id of traceReqs)
  if (!checklistReqs.has(id))
    problems.push(`trace-matrix: ${id} not defined in checklist.json requirements`)
for (const id of checklistReqs)
  if (!traceReqs.has(id))
    problems.push(`trace-matrix: requirement ${id} not referenced in trace-matrix.md`)

// --- 5. milestone membership, both directions ---
for (const ms of checklist.milestones ?? []) {
  const listed = new Set(ms.featureIds ?? [])
  for (const fid of listed)
    if (!checkFeatureIds.has(fid)) problems.push(`milestone ${ms.id}: unknown feature ${fid}`)
  const expected = (checklist.features ?? []).filter((f) => f.milestone === ms.id).map((f) => f.id)
  for (const fid of expected)
    if (!listed.has(fid))
      problems.push(
        `milestone ${ms.id}: feature ${fid} sets milestone="${fid}" field but missing from ${ms.id}.featureIds`,
      )
  for (const fid of listed) {
    const f = (checklist.features ?? []).find((x) => x.id === fid)
    if (f && f.milestone !== ms.id)
      problems.push(`milestone ${ms.id}: ${fid} is also listed under milestone "${f.milestone}"`)
  }
}

// --- 6. designDoc paths exist ---
for (const f of checklist.features ?? []) {
  if (f.designDoc && !existsSync(join(ROOT, f.designDoc)))
    problems.push(`checklist: ${f.id} designDoc missing on disk: ${f.designDoc}`)
}

// --- report ---
info.push(`features: ${checkFeatureIds.size} (docs: ${docFeatureIds.size})`)
info.push(`requirements: ${checklistReqs.size}; milestones: ${milestoneIds.size}`)
info.push(`design docs checked: ${walkMd(DESIGN).length - 1} (+TEMPLATE skipped)`)

for (const line of info) console.log(`  ok  ${line}`)
if (problems.length) {
  console.error(`\nFAIL: ${problems.length} finding(s):`)
  for (const p of problems) console.error(`  ✗  ${p}`)
  process.exit(1)
}
console.log('\nPASS: design ↔ checklist consistency verified.')
