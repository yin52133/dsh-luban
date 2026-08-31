#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { parseArgs } from 'node:util'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const RUNNER_PATH = fileURLToPath(import.meta.url)
const SCOPE = 'M03-F001+M03-F003/ubuntu-tmux-continuation'
const COVERED_FEATURES = Object.freeze(['M03-F001', 'M03-F003'])
const EVIDENCE_SCHEMA = 'dsh-luban/m03-ubuntu-keepalive/v1'
const MARKER_SCHEMA = 'dsh-luban/m03-ubuntu-owner/v1'
const WITNESS_SCHEMA = 'dsh-luban/m03-ubuntu-disconnect-witness/v1'
const HEARTBEAT_SCHEMA = 'dsh-luban/m03-ubuntu-heartbeat/v1'
const SYSTEMD_UNIT = 'dsh-luban.service'
const DEFAULT_LEDGER = resolve(homedir(), '.dsh/luban/keepalive/ledger.json')
const MAX_JSON_BYTES = 256 * 1024
const MAX_LEDGER_BYTES = 4 * 1024 * 1024
const HEARTBEAT_MAX_AGE_MS = 15_000
const COMMAND_TIMEOUT_MS = 15_000
const ATTACH_TIMEOUT_MS = 12 * 60 * 60 * 1_000
const STEP_LIST = Object.freeze([
  'prepare',
  'verify-disconnect',
  'observe-attach',
  'arm-reboot',
  'verify-reboot',
])
const STAGES = Object.freeze([
  'prepared',
  'disconnect-verified',
  'attach-observed',
  'reboot-armed',
  'reboot-verified',
  'cleaned',
])
const COMMANDS = Object.freeze([
  'plan',
  'preflight',
  'prepare',
  'verify-disconnect',
  'observe-attach',
  'arm-reboot',
  'verify-reboot',
  'cleanup',
])
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

const HELP = `M03 Ubuntu/tmux staged acceptance

Usage:
  node scripts/acceptance/m03-ubuntu-keepalive.mjs [plan]
  node scripts/acceptance/m03-ubuntu-keepalive.mjs preflight [--ledger ABSOLUTE_FILE]
  node scripts/acceptance/m03-ubuntu-keepalive.mjs prepare --apply --run-dir ABSOLUTE_EXTERNAL_DIR [--ledger ABSOLUTE_FILE]
  node scripts/acceptance/m03-ubuntu-keepalive.mjs verify-disconnect --run-dir DIR --witness EXTERNAL_JSON
  node scripts/acceptance/m03-ubuntu-keepalive.mjs observe-attach --run-dir DIR
  node scripts/acceptance/m03-ubuntu-keepalive.mjs arm-reboot --run-dir DIR
  node scripts/acceptance/m03-ubuntu-keepalive.mjs verify-reboot --run-dir DIR
  node scripts/acceptance/m03-ubuntu-keepalive.mjs cleanup --apply --run-dir DIR [--ledger ABSOLUTE_FILE]

The runner never disconnects SSH, reboots, changes linger, or installs/removes a systemd unit.
prepare/cleanup require --apply. Verification stages append evidence and advance only the owned
checkpoint. Evidence lives in an explicit directory outside the repository. Simulation never passes.
`

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} has unexpected fields`)
}

function hasAsciiControl(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0)
    return code !== undefined && (code <= 0x1f || code === 0x7f)
  })
}

function boundedText(value, label, maximum = 4_096) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.length > maximum ||
    hasAsciiControl(value)
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`)
  return value
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is invalid`)
  return value
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeFailure(code, message, exitCode = 1) {
  return {
    exitCode,
    output: JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message } }),
  }
}

function pathInput(value, label) {
  if (typeof value !== 'string' || value === '' || hasAsciiControl(value)) {
    throw new Error(`${label} is invalid`)
  }
  const path = resolve(value)
  if (!isAbsolute(value) || path === parse(path).root || basename(path) === '') {
    throw new Error(`${label} must be an absolute non-root path`)
  }
  return path
}

function parseCli(argv) {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      apply: { type: 'boolean' },
      'run-dir': { type: 'string' },
      ledger: { type: 'string' },
      witness: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (parsed.positionals.length > 1) throw new Error('invalid command')
  const command = parsed.positionals[0] ?? 'plan'
  if (!COMMANDS.includes(command)) throw new Error('invalid command')
  const apply = parsed.values.apply === true
  if (apply && command !== 'prepare' && command !== 'cleanup') {
    throw new Error('--apply is limited to prepare and cleanup')
  }
  if (parsed.values.witness !== undefined && command !== 'verify-disconnect') {
    throw new Error('--witness is limited to verify-disconnect')
  }
  const runDir =
    parsed.values['run-dir'] === undefined
      ? undefined
      : pathInput(parsed.values['run-dir'], 'run directory')
  if (!['plan', 'preflight'].includes(command) && runDir === undefined) {
    throw new Error('--run-dir is required for this command')
  }
  const ledger =
    parsed.values.ledger === undefined
      ? DEFAULT_LEDGER
      : pathInput(parsed.values.ledger, 'ledger path')
  const witness =
    parsed.values.witness === undefined
      ? undefined
      : pathInput(parsed.values.witness, 'witness path')
  if (command === 'verify-disconnect' && witness === undefined) {
    throw new Error('--witness is required for verify-disconnect')
  }
  return {
    command,
    apply,
    runDir,
    ledger,
    witness,
    help: parsed.values.help === true,
  }
}

function outsideRepository(path) {
  const within = relative(REPOSITORY_ROOT, path)
  return within !== '' && within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within)
    ? false
    : path !== REPOSITORY_ROOT
}

async function assertExternalPath(path, label, existing) {
  if (!outsideRepository(path)) throw new Error(`${label} must be outside the repository`)
  const target = existing ? path : dirname(path)
  const stats = await lstat(target)
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${label} is unsafe`)
  if (existing && process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(`${label} must be accessible only to its owner`)
  }
  const canonical = await realpath(target)
  const canonicalStats = await lstat(canonical)
  if (
    !sameIdentity(stats, canonicalStats) ||
    (process.platform !== 'win32' && resolve(canonical) !== resolve(target))
  ) {
    throw new Error(`${label} crosses a link`)
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

async function readBoundedFile(path, maximum) {
  const initial = await lstat(path)
  if (initial.isSymbolicLink() || !initial.isFile() || initial.size > maximum) {
    throw new Error('file is unsafe')
  }
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > maximum || !sameIdentity(initial, opened)) {
      throw new Error('file changed during inspection')
    }
    const content = await handle.readFile()
    if (content.byteLength > maximum) throw new Error('file exceeded its size limit')
    const final = await lstat(path)
    if (final.isSymbolicLink() || !final.isFile() || !sameIdentity(opened, final)) {
      throw new Error('file changed during inspection')
    }
    return content
  } finally {
    await handle.close()
  }
}

async function readJson(path, maximum = MAX_JSON_BYTES) {
  return JSON.parse((await readBoundedFile(path, maximum)).toString('utf8'))
}

async function writeJsonNew(path, value) {
  const serialized = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (serialized.byteLength > MAX_JSON_BYTES) throw new Error('evidence is too large')
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(serialized)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  try {
    await link(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await rm(temporary)
  return sha256(serialized)
}

function normalizeSource(value) {
  exactKeys(value, ['gitHead', 'runnerSha256'], 'source identity')
  const gitHead = boundedText(value.gitHead, 'Git HEAD', 64)
  const runnerSha256 = boundedText(value.runnerSha256, 'runner hash', 64)
  if (!/^[a-f0-9]{40,64}$/u.test(gitHead) || !/^[a-f0-9]{64}$/u.test(runnerSha256)) {
    throw new Error('source identity is invalid')
  }
  return { gitHead, runnerSha256 }
}

function normalizeSystemd(value) {
  exactKeys(
    value,
    ['unit', 'enabled', 'active', 'mainPid', 'bootRestoreSentinel'],
    'systemd status',
  )
  if (
    value.unit !== SYSTEMD_UNIT ||
    value.enabled !== 'enabled' ||
    value.active !== 'active' ||
    value.bootRestoreSentinel !== true
  ) {
    throw new Error('systemd service is not ready for boot restore')
  }
  return {
    unit: SYSTEMD_UNIT,
    enabled: 'enabled',
    active: 'active',
    mainPid: positiveInteger(value.mainPid, 'systemd MainPID'),
    bootRestoreSentinel: true,
  }
}

function normalizeHost(value) {
  exactKeys(
    value,
    [
      'machineIdSha256',
      'bootId',
      'source',
      'systemd',
      'ubuntuVersion',
      'nodeVersion',
      'tmuxVersion',
      'linger',
    ],
    'host snapshot',
  )
  const machineIdSha256 = boundedText(value.machineIdSha256, 'machine id hash', 64)
  const bootId = boundedText(value.bootId, 'boot id', 64)
  if (!/^[a-f0-9]{64}$/u.test(machineIdSha256) || !/^[a-f0-9-]{16,64}$/u.test(bootId)) {
    throw new Error('host identity is invalid')
  }
  if (value.linger !== 'yes') throw new Error('systemd user linger is not enabled')
  return {
    machineIdSha256,
    bootId,
    source: normalizeSource(value.source),
    systemd: normalizeSystemd(value.systemd),
    ubuntuVersion: boundedText(value.ubuntuVersion, 'Ubuntu version', 64),
    nodeVersion: boundedText(value.nodeVersion, 'Node version', 64),
    tmuxVersion: boundedText(value.tmuxVersion, 'tmux version', 64),
    linger: 'yes',
  }
}

function normalizeTmux(value, marker) {
  exactKeys(
    value,
    ['sessionName', 'tmuxSessionId', 'paneId', 'panePid', 'commandSha256'],
    'tmux snapshot',
  )
  if (
    value.sessionName !== marker.sessionId ||
    value.commandSha256 !== marker.commandSha256 ||
    !/^\$[0-9]+$/u.test(value.tmuxSessionId) ||
    !/^%[0-9]+$/u.test(value.paneId)
  ) {
    throw new Error('tmux identity does not match the owned session')
  }
  return {
    sessionName: marker.sessionId,
    tmuxSessionId: value.tmuxSessionId,
    paneId: value.paneId,
    panePid: positiveInteger(value.panePid, 'tmux pane pid'),
    commandSha256: marker.commandSha256,
  }
}

function normalizeHeartbeat(value, marker) {
  exactKeys(
    value,
    [
      'schemaVersion',
      'runId',
      'machineIdSha256',
      'bootId',
      'pid',
      'sequence',
      'startedAt',
      'observedAt',
    ],
    'heartbeat',
  )
  if (value.schemaVersion !== HEARTBEAT_SCHEMA || value.runId !== marker.runId) {
    throw new Error('heartbeat ownership is invalid')
  }
  return {
    schemaVersion: HEARTBEAT_SCHEMA,
    runId: marker.runId,
    machineIdSha256: boundedText(value.machineIdSha256, 'heartbeat machine id', 64),
    bootId: boundedText(value.bootId, 'heartbeat boot id', 64),
    pid: positiveInteger(value.pid, 'heartbeat pid'),
    sequence: positiveInteger(value.sequence, 'heartbeat sequence'),
    startedAt: nonNegativeInteger(value.startedAt, 'heartbeat start'),
    observedAt: nonNegativeInteger(value.observedAt, 'heartbeat observation'),
  }
}

function normalizeCheckpoint(value, marker) {
  exactKeys(value, ['taskId', 'stepList', 'currentStep', 'savedAt'], 'checkpoint')
  if (
    value.taskId !== marker.taskId ||
    !isDeepStrictEqual(value.stepList, STEP_LIST) ||
    !Number.isSafeInteger(value.currentStep) ||
    value.currentStep < 1 ||
    value.currentStep > STEP_LIST.length
  ) {
    throw new Error('checkpoint does not match the owned acceptance plan')
  }
  return {
    taskId: marker.taskId,
    stepList: STEP_LIST,
    currentStep: value.currentStep,
    savedAt: nonNegativeInteger(value.savedAt, 'checkpoint saved time'),
  }
}

function normalizeLedgerSnapshot(value, marker) {
  exactKeys(
    value,
    ['sessionId', 'ownerTaskId', 'sessionCreatedAt', 'checkpoint'],
    'ledger snapshot',
  )
  if (value.sessionId !== marker.sessionId || value.ownerTaskId !== marker.taskId) {
    throw new Error('ledger ownership is invalid')
  }
  return {
    sessionId: marker.sessionId,
    ownerTaskId: marker.taskId,
    sessionCreatedAt: nonNegativeInteger(value.sessionCreatedAt, 'managed session creation time'),
    checkpoint: normalizeCheckpoint(value.checkpoint, marker),
  }
}

function normalizeFixture(value, marker, now) {
  exactKeys(value, ['tmux', 'heartbeat', 'ledger'], 'fixture snapshot')
  const fixture = {
    tmux: normalizeTmux(value.tmux, marker),
    heartbeat: normalizeHeartbeat(value.heartbeat, marker),
    ledger: normalizeLedgerSnapshot(value.ledger, marker),
  }
  if (
    fixture.heartbeat.observedAt > now + 1_000 ||
    now - fixture.heartbeat.observedAt > HEARTBEAT_MAX_AGE_MS ||
    fixture.heartbeat.startedAt > fixture.heartbeat.observedAt ||
    fixture.ledger.sessionCreatedAt > now + 1_000 ||
    fixture.ledger.checkpoint.savedAt > now + 1_000
  ) {
    throw new Error('heartbeat is not current')
  }
  return fixture
}

function assertSnapshot(host, fixture, marker) {
  if (
    host.machineIdSha256 !== marker.machineIdSha256 ||
    !isDeepStrictEqual(host.source, marker.source) ||
    fixture.heartbeat.machineIdSha256 !== host.machineIdSha256 ||
    fixture.heartbeat.bootId !== host.bootId
  ) {
    throw new Error('host, source, and fixture identities do not match')
  }
}

function markerCommand(runDir, runId) {
  return [
    process.execPath,
    RUNNER_PATH,
    '__heartbeat-worker',
    '--run-dir',
    runDir,
    '--run-id',
    runId,
  ]
}

function posixCommand(argv) {
  return argv.map((value) => `'${value.replaceAll("'", `'"'"'`)}'`).join(' ')
}

export function tmuxPaneCommandSha256(command, expectedSha256) {
  const direct = sha256(command)
  if (direct === expectedSha256) return direct

  // tmux 3.4 may add one display-only double-quote layer around a command
  // composed entirely from POSIX single-quoted arguments.
  if (command.startsWith('"') && command.endsWith('"')) {
    const unwrapped = sha256(command.slice(1, -1))
    if (unwrapped === expectedSha256) return unwrapped
  }
  return direct
}

function markerFor({ runDir, ledgerPath, evidenceKind, source, host, now }) {
  const runId = randomUUID()
  const sessionId = `luban-m03-${runId.replaceAll('-', '').slice(0, 12)}`
  const taskId = `M03-ACCEPT-${runId}`
  return {
    schemaVersion: MARKER_SCHEMA,
    evidenceKind,
    runId,
    createdAt: now,
    runDir,
    ledgerPath,
    source,
    machineIdSha256: host.machineIdSha256,
    sessionId,
    taskId,
    commandSha256: sha256(posixCommand(markerCommand(runDir, runId))),
  }
}

function validateMarker(value, expectedRunDir) {
  exactKeys(
    value,
    [
      'schemaVersion',
      'evidenceKind',
      'runId',
      'createdAt',
      'runDir',
      'ledgerPath',
      'source',
      'machineIdSha256',
      'sessionId',
      'taskId',
      'commandSha256',
    ],
    'owner marker',
  )
  if (
    value.schemaVersion !== MARKER_SCHEMA ||
    !['operator-attested', 'simulated'].includes(value.evidenceKind) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value.runId) ||
    value.runDir !== expectedRunDir ||
    value.sessionId !== `luban-m03-${value.runId.replaceAll('-', '').slice(0, 12)}` ||
    value.taskId !== `M03-ACCEPT-${value.runId}`
  ) {
    throw new Error('owner marker is invalid')
  }
  const marker = {
    schemaVersion: MARKER_SCHEMA,
    evidenceKind: value.evidenceKind,
    runId: value.runId,
    createdAt: nonNegativeInteger(value.createdAt, 'marker time'),
    runDir: value.runDir,
    ledgerPath: pathInput(value.ledgerPath, 'marker ledger path'),
    source: normalizeSource(value.source),
    machineIdSha256: boundedText(value.machineIdSha256, 'marker machine id', 64),
    sessionId: value.sessionId,
    taskId: value.taskId,
    commandSha256: boundedText(value.commandSha256, 'command hash', 64),
  }
  if (
    !/^[a-f0-9]{64}$/u.test(marker.machineIdSha256) ||
    !/^[a-f0-9]{64}$/u.test(marker.commandSha256) ||
    marker.commandSha256 !== sha256(posixCommand(markerCommand(marker.runDir, marker.runId)))
  ) {
    throw new Error('owner marker binding is invalid')
  }
  return marker
}

function pendingObservations() {
  return {
    disconnect: { status: 'pending' },
    attach: { status: 'pending' },
    reboot: { status: 'pending' },
  }
}

function normalizeObservations(value) {
  exactKeys(value, ['disconnect', 'attach', 'reboot'], 'observations')
  const disconnect = value.disconnect
  if (disconnect?.status === 'pending') exactKeys(disconnect, ['status'], 'disconnect observation')
  else {
    exactKeys(
      disconnect,
      ['status', 'witnessSha256', 'disconnectedAt', 'reconnectedAt', 'observer'],
      'disconnect observation',
    )
    if (disconnect.status !== 'pass' || !/^[a-f0-9]{64}$/u.test(disconnect.witnessSha256)) {
      throw new Error('disconnect observation is invalid')
    }
    boundedText(disconnect.observer, 'disconnect observer', 128)
    nonNegativeInteger(disconnect.disconnectedAt, 'disconnect time')
    nonNegativeInteger(disconnect.reconnectedAt, 'reconnect time')
    if (disconnect.reconnectedAt <= disconnect.disconnectedAt) {
      throw new Error('disconnect witness interval is invalid')
    }
  }
  const attach = value.attach
  if (attach?.status === 'pending') exactKeys(attach, ['status'], 'attach observation')
  else {
    exactKeys(attach, ['status', 'observedAt'], 'attach observation')
    if (attach.status !== 'pass') throw new Error('attach observation is invalid')
    nonNegativeInteger(attach.observedAt, 'attach observation time')
  }
  const reboot = value.reboot
  if (reboot?.status === 'pending') exactKeys(reboot, ['status'], 'reboot observation')
  else if (reboot?.status === 'armed') {
    exactKeys(reboot, ['status', 'armedAt', 'bootId', 'mainPid'], 'reboot observation')
    nonNegativeInteger(reboot.armedAt, 'reboot arm time')
    boundedText(reboot.bootId, 'armed boot id', 64)
    positiveInteger(reboot.mainPid, 'armed MainPID')
  } else {
    exactKeys(
      reboot,
      ['status', 'armedAt', 'armedBootId', 'verifiedAt', 'verifiedBootId', 'mainPid'],
      'reboot observation',
    )
    if (reboot?.status !== 'pass' || reboot.verifiedBootId === reboot.armedBootId) {
      throw new Error('reboot observation is invalid')
    }
    nonNegativeInteger(reboot.armedAt, 'reboot arm time')
    nonNegativeInteger(reboot.verifiedAt, 'reboot verification time')
    boundedText(reboot.armedBootId, 'armed boot id', 64)
    boundedText(reboot.verifiedBootId, 'verified boot id', 64)
    positiveInteger(reboot.mainPid, 'verified MainPID')
  }
  return value
}

function verdict(evidenceKind, observations) {
  const direct = evidenceKind === 'operator-attested'
  const f001 =
    direct && observations.disconnect.status === 'pass' && observations.attach.status === 'pass'
  const f003 = direct && observations.reboot.status === 'pass'
  return {
    acceptancePassed: f001 && f003,
    featureResults: {
      'M03-F001': {
        passed: f001,
        reason: f001
          ? 'human SSH disconnect witness plus same-boot tmux attach/detach and heartbeat continuity observed'
          : evidenceKind === 'simulated'
            ? 'simulated execution cannot prove SSH disconnect or real tmux attachment'
            : 'SSH disconnect witness and real tmux attach/detach observation are incomplete',
      },
      'M03-F003': {
        passed: f003,
        reason: f003
          ? 'new boot, active systemd MainPID, ledger-owned checkpoint, and restarted heartbeat observed'
          : evidenceKind === 'simulated'
            ? 'simulated execution cannot prove reboot recovery'
            : 'human reboot and post-boot ledger/checkpoint continuation are incomplete',
      },
    },
  }
}

function safetyBoundary() {
  return {
    disconnectCommandExecuted: false,
    rebootCommandExecuted: false,
    lingerChanged: false,
    systemdUnitInstalledOrRemoved: false,
  }
}

function evidenceFor({
  marker,
  previous,
  previousSha256,
  stage,
  host,
  fixture,
  observations,
  now,
}) {
  const result = verdict(marker.evidenceKind, observations)
  const sequence = (previous?.sequence ?? 0) + 1
  const binding = previous?.binding ?? {
    source: marker.source,
    machineIdSha256: marker.machineIdSha256,
    preparedBootId: host.bootId,
    preparedMainPid: host.systemd.mainPid,
    sessionId: marker.sessionId,
    taskId: marker.taskId,
    preparedTmuxSessionId: fixture.tmux.tmuxSessionId,
    preparedPaneId: fixture.tmux.paneId,
    preparedPanePid: fixture.tmux.panePid,
    preparedHeartbeatPid: fixture.heartbeat.pid,
    preparedHeartbeatStartedAt: fixture.heartbeat.startedAt,
    preparedSessionCreatedAt: fixture.ledger.sessionCreatedAt,
    ledgerPathSha256: sha256(marker.ledgerPath),
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA,
    scope: SCOPE,
    coveredFeatures: COVERED_FEATURES,
    evidenceKind: marker.evidenceKind,
    runId: marker.runId,
    stage,
    sequence,
    previousSha256: previousSha256 ?? null,
    recordedAt: now,
    binding,
    observations,
    latest: { host, fixture },
    cleanup: 'pending',
    acceptancePassed: result.acceptancePassed,
    featureResults: result.featureResults,
    safety: safetyBoundary(),
  }
}

function cleanedEvidence({ previous, previousSha256, now }) {
  return {
    ...previous,
    stage: 'cleaned',
    sequence: previous.sequence + 1,
    previousSha256,
    recordedAt: now,
    latest: null,
    cleanup: 'pass',
    safety: safetyBoundary(),
  }
}

function validateBinding(value, marker) {
  exactKeys(
    value,
    [
      'source',
      'machineIdSha256',
      'preparedBootId',
      'preparedMainPid',
      'sessionId',
      'taskId',
      'preparedTmuxSessionId',
      'preparedPaneId',
      'preparedPanePid',
      'preparedHeartbeatPid',
      'preparedHeartbeatStartedAt',
      'preparedSessionCreatedAt',
      'ledgerPathSha256',
    ],
    'evidence binding',
  )
  if (
    !isDeepStrictEqual(normalizeSource(value.source), marker.source) ||
    value.machineIdSha256 !== marker.machineIdSha256 ||
    value.sessionId !== marker.sessionId ||
    value.taskId !== marker.taskId ||
    value.ledgerPathSha256 !== sha256(marker.ledgerPath) ||
    !/^\$[0-9]+$/u.test(value.preparedTmuxSessionId) ||
    !/^%[0-9]+$/u.test(value.preparedPaneId)
  ) {
    throw new Error('evidence binding is invalid')
  }
  boundedText(value.preparedBootId, 'prepared boot id', 64)
  positiveInteger(value.preparedMainPid, 'prepared MainPID')
  positiveInteger(value.preparedPanePid, 'prepared tmux pane PID')
  positiveInteger(value.preparedHeartbeatPid, 'prepared heartbeat PID')
  nonNegativeInteger(value.preparedHeartbeatStartedAt, 'prepared heartbeat start')
  nonNegativeInteger(value.preparedSessionCreatedAt, 'prepared session creation time')
  return value
}

function matchesPreparedRuntime(host, fixture, binding) {
  return (
    host.systemd.mainPid === binding.preparedMainPid &&
    fixture.tmux.tmuxSessionId === binding.preparedTmuxSessionId &&
    fixture.tmux.paneId === binding.preparedPaneId &&
    fixture.tmux.panePid === binding.preparedPanePid &&
    fixture.heartbeat.pid === binding.preparedHeartbeatPid &&
    fixture.heartbeat.startedAt === binding.preparedHeartbeatStartedAt &&
    fixture.ledger.sessionCreatedAt === binding.preparedSessionCreatedAt
  )
}

function assertStageInvariants(stage, binding, observations, latest, previous, recordedAt) {
  if (stage === 'cleaned') {
    if (
      previous === null ||
      !isDeepStrictEqual(observations, previous.observations) ||
      previous.cleanup !== 'pending'
    ) {
      throw new Error('cleaned evidence changed prior observations')
    }
    return
  }
  const { host, fixture } = latest
  const step = fixture.ledger.checkpoint.currentStep
  const disconnectPassed = observations.disconnect.status === 'pass'
  const attachPassed = observations.attach.status === 'pass'
  const samePreparedBoot = host.bootId === binding.preparedBootId
  const samePreparedRuntime = matchesPreparedRuntime(host, fixture, binding)

  if (stage === 'prepared') {
    if (
      step !== 1 ||
      !samePreparedBoot ||
      !samePreparedRuntime ||
      disconnectPassed ||
      attachPassed ||
      observations.reboot.status !== 'pending'
    ) {
      throw new Error('prepared evidence is internally inconsistent')
    }
    return
  }
  if (stage === 'disconnect-verified') {
    if (
      step !== 2 ||
      !samePreparedBoot ||
      !samePreparedRuntime ||
      !disconnectPassed ||
      attachPassed ||
      observations.reboot.status !== 'pending' ||
      previous?.stage !== 'prepared' ||
      observations.disconnect.reconnectedAt > recordedAt ||
      fixture.heartbeat.sequence <= previous.latest.fixture.heartbeat.sequence ||
      fixture.heartbeat.observedAt <= previous.latest.fixture.heartbeat.observedAt
    ) {
      throw new Error('disconnect evidence is internally inconsistent')
    }
    return
  }
  if (stage === 'attach-observed') {
    if (
      step !== 3 ||
      !samePreparedBoot ||
      !samePreparedRuntime ||
      !disconnectPassed ||
      !attachPassed ||
      observations.reboot.status !== 'pending' ||
      previous?.stage !== 'disconnect-verified' ||
      observations.attach.observedAt < observations.disconnect.reconnectedAt ||
      observations.attach.observedAt > recordedAt ||
      fixture.heartbeat.sequence <= previous.latest.fixture.heartbeat.sequence
    ) {
      throw new Error('attach evidence is internally inconsistent')
    }
    return
  }
  if (stage === 'reboot-armed') {
    if (
      step !== 4 ||
      !samePreparedBoot ||
      !samePreparedRuntime ||
      !disconnectPassed ||
      !attachPassed ||
      observations.reboot.status !== 'armed' ||
      observations.reboot.bootId !== host.bootId ||
      observations.reboot.mainPid !== host.systemd.mainPid ||
      observations.reboot.armedAt < observations.attach.observedAt ||
      observations.reboot.armedAt > recordedAt ||
      previous?.stage !== 'attach-observed'
    ) {
      throw new Error('reboot arm evidence is internally inconsistent')
    }
    return
  }
  if (
    step !== 5 ||
    samePreparedBoot ||
    !disconnectPassed ||
    !attachPassed ||
    observations.reboot.status !== 'pass' ||
    observations.reboot.armedBootId !== binding.preparedBootId ||
    observations.reboot.verifiedBootId !== host.bootId ||
    observations.reboot.mainPid !== host.systemd.mainPid ||
    observations.reboot.verifiedAt <= observations.reboot.armedAt ||
    observations.reboot.verifiedAt > recordedAt ||
    fixture.heartbeat.startedAt <= observations.reboot.armedAt ||
    fixture.ledger.sessionCreatedAt <= observations.reboot.armedAt ||
    previous?.stage !== 'reboot-armed'
  ) {
    throw new Error('reboot verification evidence is internally inconsistent')
  }
}

function validateEvidence(value, marker, expectedSequence, previousSha256, previous) {
  exactKeys(
    value,
    [
      'schemaVersion',
      'scope',
      'coveredFeatures',
      'evidenceKind',
      'runId',
      'stage',
      'sequence',
      'previousSha256',
      'recordedAt',
      'binding',
      'observations',
      'latest',
      'cleanup',
      'acceptancePassed',
      'featureResults',
      'safety',
    ],
    'evidence',
  )
  if (
    value.schemaVersion !== EVIDENCE_SCHEMA ||
    value.scope !== SCOPE ||
    !isDeepStrictEqual(value.coveredFeatures, COVERED_FEATURES) ||
    value.evidenceKind !== marker.evidenceKind ||
    value.runId !== marker.runId ||
    !STAGES.includes(value.stage) ||
    value.sequence !== expectedSequence ||
    value.previousSha256 !== previousSha256
  ) {
    throw new Error('evidence envelope is invalid')
  }
  nonNegativeInteger(value.recordedAt, 'evidence time')
  const binding = validateBinding(value.binding, marker)
  const observations = normalizeObservations(value.observations)
  exactKeys(
    value.safety,
    [
      'disconnectCommandExecuted',
      'rebootCommandExecuted',
      'lingerChanged',
      'systemdUnitInstalledOrRemoved',
    ],
    'safety boundary',
  )
  if (!isDeepStrictEqual(value.safety, safetyBoundary()))
    throw new Error('safety boundary is invalid')
  const expectedVerdict = verdict(marker.evidenceKind, observations)
  if (
    value.acceptancePassed !== expectedVerdict.acceptancePassed ||
    !isDeepStrictEqual(value.featureResults, expectedVerdict.featureResults)
  ) {
    throw new Error('acceptance verdict contradicts evidence')
  }
  if (value.stage === 'cleaned') {
    if (value.latest !== null || value.cleanup !== 'pass' || previous === null) {
      throw new Error('cleaned evidence is invalid')
    }
    assertStageInvariants(
      value.stage,
      binding,
      observations,
      value.latest,
      previous,
      value.recordedAt,
    )
  } else {
    exactKeys(value.latest, ['host', 'fixture'], 'latest snapshot')
    const host = normalizeHost(value.latest.host)
    const fixture = normalizeFixture(value.latest.fixture, marker, value.recordedAt)
    assertSnapshot(host, fixture, marker)
    if (value.cleanup !== 'pending') throw new Error('active evidence cleanup is invalid')
    if (
      host.machineIdSha256 !== binding.machineIdSha256 ||
      !isDeepStrictEqual(host.source, binding.source)
    ) {
      throw new Error('latest snapshot escaped its binding')
    }
    assertStageInvariants(
      value.stage,
      binding,
      observations,
      { host, fixture },
      previous,
      value.recordedAt,
    )
  }
  if (previous !== null) {
    if (
      !isDeepStrictEqual(value.binding, previous.binding) ||
      value.recordedAt < previous.recordedAt
    ) {
      throw new Error('evidence chain binding changed')
    }
    const allowed =
      value.stage === 'cleaned' ||
      (previous.stage === 'prepared' && value.stage === 'disconnect-verified') ||
      (previous.stage === 'disconnect-verified' && value.stage === 'attach-observed') ||
      (previous.stage === 'attach-observed' && value.stage === 'reboot-armed') ||
      (previous.stage === 'reboot-armed' && value.stage === 'reboot-verified')
    if (!allowed || previous.stage === 'cleaned')
      throw new Error('invalid evidence state transition')
  } else if (value.stage !== 'prepared') {
    throw new Error('evidence chain must begin with prepared')
  }
  return value
}

function evidenceFileName(sequence, stage) {
  return `${String(sequence).padStart(2, '0')}-${stage}.json`
}

async function readEvidenceChain(runDir, marker) {
  const directory = join(runDir, 'evidence')
  await assertExternalPath(directory, 'evidence directory', true)
  const entries = await readdir(directory, { withFileTypes: true })
  const files = entries.map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^\d{2}-[a-z-]+\.json$/u.test(entry.name)) {
      throw new Error('evidence directory contains an unexpected entry')
    }
    return entry.name
  })
  files.sort()
  let previous = null
  let previousSha256 = null
  for (const [index, name] of files.entries()) {
    const expectedSequence = index + 1
    if (!name.startsWith(`${String(expectedSequence).padStart(2, '0')}-`)) {
      throw new Error('evidence sequence is not contiguous')
    }
    const bytes = await readBoundedFile(join(directory, name), MAX_JSON_BYTES)
    const value = JSON.parse(bytes.toString('utf8'))
    previous = validateEvidence(value, marker, expectedSequence, previousSha256, previous)
    if (name !== evidenceFileName(expectedSequence, previous.stage)) {
      throw new Error('evidence filename contradicts its stage')
    }
    previousSha256 = sha256(bytes)
  }
  return { latest: previous, latestSha256: previousSha256 }
}

async function appendEvidence(runDir, evidence, marker, previous, previousSha256) {
  validateEvidence(evidence, marker, evidence.sequence, previousSha256, previous)
  await assertExternalPath(runDir, 'run directory', true)
  await assertExternalPath(join(runDir, 'evidence'), 'evidence directory', true)
  const path = join(runDir, 'evidence', evidenceFileName(evidence.sequence, evidence.stage))
  return await writeJsonNew(path, evidence)
}

async function createRunDirectory(runDir, marker) {
  await assertExternalPath(runDir, 'run directory', false)
  await mkdir(runDir, { mode: 0o700 })
  try {
    await assertExternalPath(runDir, 'run directory', true)
    await mkdir(join(runDir, 'evidence'), { mode: 0o700 })
    await writeJsonNew(join(runDir, 'owner.json'), marker)
  } catch (error) {
    await rm(join(runDir, 'owner.json'), { force: true }).catch(() => undefined)
    await rmdir(join(runDir, 'evidence')).catch(() => undefined)
    await rmdir(runDir).catch(() => undefined)
    throw error
  }
}

async function loadOwnerMarker(runDir) {
  await assertExternalPath(runDir, 'run directory', true)
  return validateMarker(await readJson(join(runDir, 'owner.json')), runDir)
}

async function loadRun(runDir) {
  const marker = await loadOwnerMarker(runDir)
  const chain = await readEvidenceChain(runDir, marker)
  return { marker, ...chain }
}

async function readDisconnectWitness(path, marker, previous, now) {
  await assertExternalPath(path, 'disconnect witness', false)
  const bytes = await readBoundedFile(path, MAX_JSON_BYTES)
  const value = JSON.parse(bytes.toString('utf8'))
  exactKeys(
    value,
    [
      'schemaVersion',
      'runId',
      'machineIdSha256',
      'bootId',
      'observer',
      'sshDisconnected',
      'disconnectedAt',
      'reconnectedAt',
    ],
    'disconnect witness',
  )
  if (
    value.schemaVersion !== WITNESS_SCHEMA ||
    value.runId !== marker.runId ||
    value.machineIdSha256 !== marker.machineIdSha256 ||
    value.bootId !== previous.binding.preparedBootId ||
    value.sshDisconnected !== true ||
    !Number.isSafeInteger(value.disconnectedAt) ||
    !Number.isSafeInteger(value.reconnectedAt) ||
    value.disconnectedAt < previous.recordedAt ||
    value.reconnectedAt <= value.disconnectedAt ||
    value.reconnectedAt > now + 1_000
  ) {
    throw new Error('disconnect witness is invalid')
  }
  return {
    status: 'pass',
    witnessSha256: sha256(bytes),
    disconnectedAt: value.disconnectedAt,
    reconnectedAt: value.reconnectedAt,
    observer: boundedText(value.observer, 'disconnect observer', 128),
  }
}

function planEnvelope(parsed) {
  return {
    exitCode: 0,
    output: JSON.stringify({
      schemaVersion: 1,
      ok: true,
      mode: 'plan',
      scope: SCOPE,
      coveredFeatures: COVERED_FEATURES,
      acceptancePassed: false,
      evidenceDirectory: parsed.runDir ?? 'explicit absolute directory outside repository required',
      ledger: parsed.ledger,
      stages: [
        { stage: 'preflight', mutation: 'none', readOnly: true },
        {
          stage: 'prepare',
          mutation: 'external owner/evidence directory, owned tmux heartbeat, and ledger record',
          requiresApply: true,
        },
        { stage: 'human-ssh-disconnect', mutation: 'external-human-action', automated: false },
        {
          stage: 'verify-disconnect',
          mutation: 'owned checkpoint advance plus append-only evidence',
          witnessRequired: true,
        },
        {
          stage: 'observe-attach',
          mutation: 'interactive tmux attach/detach, owned checkpoint advance, and evidence',
        },
        {
          stage: 'arm-reboot',
          mutation: 'owned checkpoint advance plus append-only evidence',
          rebootExecuted: false,
        },
        { stage: 'human-reboot', mutation: 'external-human-action', automated: false },
        {
          stage: 'verify-reboot',
          mutation: 'owned checkpoint advance plus append-only evidence',
        },
        {
          stage: 'cleanup',
          mutation: 'owned tmux/heartbeat/ledger removal and cleanup evidence when chain is valid',
          requiresApply: true,
        },
      ],
      safety: safetyBoundary(),
      remainingHumanActions: [
        'disconnect and reconnect the SSH client, then provide the strict witness JSON',
        'detach from the interactive tmux attachment with the normal tmux detach sequence',
        'after arm-reboot, obtain authorization and reboot the Ubuntu host outside this runner',
      ],
    }),
  }
}

function currentResult(marker, evidence, runDir, resumed = false) {
  return {
    exitCode: 0,
    output: JSON.stringify({
      schemaVersion: 1,
      ok: true,
      scope: SCOPE,
      evidenceKind: marker.evidenceKind,
      stage: evidence.stage,
      acceptancePassed: evidence.acceptancePassed,
      featureResults: evidence.featureResults,
      evidenceDirectory: join(runDir, 'evidence'),
      ...(resumed ? { resumed: true } : {}),
      safety: safetyBoundary(),
    }),
  }
}

function cleanupRecoveryResult(marker, runDir, evidenceStatus = 'unavailable-or-invalid') {
  return {
    exitCode: 0,
    output: JSON.stringify({
      schemaVersion: 1,
      ok: true,
      scope: SCOPE,
      evidenceKind: marker.evidenceKind,
      stage: 'cleaned',
      acceptancePassed: false,
      cleanup: 'pass',
      evidenceAppended: false,
      evidenceStatus,
      evidenceDirectory: join(runDir, 'evidence'),
      safety: safetyBoundary(),
    }),
  }
}

async function capture(command, args, options = {}) {
  for (const token of [command, ...args]) {
    if (typeof token !== 'string' || token.includes('\0')) throw new Error('invalid command token')
  }
  const accepted = options.acceptedExitCodes ?? [0]
  const maximum = options.maximum ?? 64 * 1024
  return await new Promise((resolveResult, reject) => {
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let settled = false
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const append = (current, chunk) => {
      const combined = Buffer.concat([current, chunk])
      if (combined.byteLength > maximum) {
        child.kill('SIGTERM')
        throw new Error('command output exceeded its bound')
      }
      return combined
    }
    child.stdout?.on('data', (chunk) => {
      try {
        stdout = append(stdout, chunk)
      } catch (error) {
        finish(() => reject(error))
      }
    })
    child.stderr?.on('data', (chunk) => {
      try {
        stderr = append(stderr, chunk)
      } catch (error) {
        finish(() => reject(error))
      }
    })
    child.once('error', () => finish(() => reject(new Error('command could not be started'))))
    child.once('close', (exitCode) =>
      finish(() => {
        if (!accepted.includes(exitCode ?? -1)) {
          reject(new Error('command did not pass'))
          return
        }
        resolveResult({
          exitCode: exitCode ?? -1,
          stdoutBytes: Buffer.from(stdout),
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
        })
      }),
    )
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(() => reject(new Error('command timed out')))
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS)
    timer.unref()
  })
}

async function defaultSourceIdentity() {
  const repositoryPath = 'scripts/acceptance/m03-ubuntu-keepalive.mjs'
  const headBefore = await capture('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT })
  const gitHead = headBefore.stdout.trim()
  const [statusBefore, runner, workingBlob, committedBlob, committedRunner] = await Promise.all([
    capture(
      'git',
      ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=normal'],
      {
        cwd: REPOSITORY_ROOT,
      },
    ),
    readBoundedFile(RUNNER_PATH, MAX_LEDGER_BYTES),
    capture('git', ['hash-object', `--path=${repositoryPath}`, RUNNER_PATH], {
      cwd: REPOSITORY_ROOT,
    }),
    capture('git', ['rev-parse', `${gitHead}:${repositoryPath}`], { cwd: REPOSITORY_ROOT }),
    capture('git', ['cat-file', 'blob', `${gitHead}:${repositoryPath}`], {
      cwd: REPOSITORY_ROOT,
      maximum: MAX_LEDGER_BYTES,
    }),
  ])
  const [headAfter, statusAfter] = await Promise.all([
    capture('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT }),
    capture(
      'git',
      ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=normal'],
      {
        cwd: REPOSITORY_ROOT,
      },
    ),
  ])
  if (
    statusBefore.stdout.trim() !== '' ||
    statusAfter.stdout.trim() !== '' ||
    gitHead !== headAfter.stdout.trim() ||
    workingBlob.stdout.trim() !== committedBlob.stdout.trim() ||
    !runner.equals(committedRunner.stdoutBytes)
  ) {
    throw new Error('Git source identity is not clean and stable')
  }
  return normalizeSource({
    gitHead,
    runnerSha256: sha256(runner),
  })
}

async function readSystemIdentity() {
  const [machine, boot] = await Promise.all([
    readBoundedFile('/etc/machine-id', 4_096),
    readBoundedFile('/proc/sys/kernel/random/boot_id', 4_096),
  ])
  const machineId = machine.toString('utf8').trim()
  const bootId = boot.toString('utf8').trim().toLowerCase()
  if (machineId === '' || !/^[a-f0-9-]{16,64}$/u.test(bootId)) {
    throw new Error('host identity files are invalid')
  }
  return { machineIdSha256: sha256(machineId), bootId }
}

function parseOsRelease(content) {
  const rows = Object.fromEntries(
    content
      .split(/\r?\n/u)
      .filter((line) => /^[A-Z_]+=/u.test(line))
      .map((line) => {
        const index = line.indexOf('=')
        const raw = line.slice(index + 1)
        const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
        return [line.slice(0, index), value]
      }),
  )
  if (rows.ID !== 'ubuntu') throw new Error('host is not Ubuntu')
  return rows.VERSION_ID ?? 'ubuntu'
}

function nodeSupported(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major >= 24 || (major === 22 && minor >= 19)
}

function preflightRow(id, passed) {
  return { id, status: passed ? 'pass' : 'blocked' }
}

function normalizePreflightChecks(value, ready) {
  if (value === undefined) return [preflightRow('host-readiness', ready)]
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error('preflight checks are invalid')
  }
  return value.map((check) => {
    exactKeys(check, ['id', 'status'], 'preflight check')
    const id = boundedText(check.id, 'preflight check id', 64)
    if (!/^[a-z0-9-]+$/u.test(id) || !['pass', 'blocked'].includes(check.status)) {
      throw new Error('preflight check is invalid')
    }
    return { id, status: check.status }
  })
}

function settledValue(result) {
  return result.status === 'fulfilled' ? result.value : undefined
}

function hasExactBootRestoreSentinel(value) {
  return (
    value
      .toString('utf8')
      .split('\0')
      .filter((entry) => entry === 'LUBAN_BOOT_RESTORE=1').length === 1
  )
}

async function inspectHostPreflight() {
  const username = userInfo().username
  const validUser = /^[a-z_][a-z0-9_-]{0,31}$/u.test(username)
  const results = await Promise.allSettled([
    readSystemIdentity(),
    defaultSourceIdentity(),
    readBoundedFile('/usr/lib/os-release', 16 * 1024),
    capture('tmux', ['-V']),
    validUser
      ? capture('loginctl', ['show-user', username, '--property=Linger', '--value'])
      : Promise.reject(new Error('invalid current user')),
    capture('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT], {
      acceptedExitCodes: [0, 1, 3, 4],
    }),
    capture('systemctl', ['--user', 'is-active', SYSTEMD_UNIT], {
      acceptedExitCodes: [0, 1, 3, 4],
    }),
    capture('systemctl', ['--user', 'show', SYSTEMD_UNIT, '--property=MainPID', '--value'], {
      acceptedExitCodes: [0, 1, 3, 4],
    }),
    capture('dsh', ['--version']),
  ])
  const [
    identityResult,
    sourceResult,
    osReleaseResult,
    tmuxResult,
    lingerResult,
    enabledResult,
    activeResult,
    mainPidResult,
    dshResult,
  ] = results
  const identity = settledValue(identityResult)
  const source = settledValue(sourceResult)
  const osRelease = settledValue(osReleaseResult)
  const tmux = settledValue(tmuxResult)
  const linger = settledValue(lingerResult)
  const enabled = settledValue(enabledResult)
  const active = settledValue(activeResult)
  const mainPid = settledValue(mainPidResult)
  const dsh = settledValue(dshResult)
  let ubuntuVersion
  try {
    if (osRelease !== undefined) ubuntuVersion = parseOsRelease(osRelease.toString('utf8'))
  } catch {
    ubuntuVersion = undefined
  }
  const mainPidValue = Number(mainPid?.stdout.trim())
  let processEnvironment
  let stableMainPid = false
  if (Number.isSafeInteger(mainPidValue) && mainPidValue > 0) {
    const [environmentResult, repeatedMainPidResult] = await Promise.allSettled([
      readBoundedFile(`/proc/${String(mainPidValue)}/environ`, MAX_JSON_BYTES),
      capture('systemctl', ['--user', 'show', SYSTEMD_UNIT, '--property=MainPID', '--value'], {
        acceptedExitCodes: [0, 1, 3, 4],
      }),
    ])
    processEnvironment = settledValue(environmentResult)
    const repeatedMainPid = settledValue(repeatedMainPidResult)
    stableMainPid = Number(repeatedMainPid?.stdout.trim()) === mainPidValue
  }
  const checks = [
    preflightRow('current-user', validUser),
    preflightRow('host-identity', identity !== undefined),
    preflightRow('clean-source', source !== undefined),
    preflightRow('ubuntu', ubuntuVersion !== undefined),
    preflightRow('node-version', nodeSupported(process.version)),
    preflightRow('tmux', tmux !== undefined && /^tmux\s/u.test(tmux.stdout.trim())),
    preflightRow(
      'dsh',
      dsh !== undefined && (dsh.stdout.trim() !== '' || dsh.stderr.trim() !== ''),
    ),
    preflightRow('linger', linger?.stdout.trim().toLowerCase() === 'yes'),
    preflightRow('systemd-enabled', enabled?.stdout.trim() === 'enabled'),
    preflightRow('systemd-active', active?.stdout.trim() === 'active'),
    preflightRow(
      'systemd-main-pid',
      Number.isSafeInteger(mainPidValue) && mainPidValue > 0 && stableMainPid,
    ),
    preflightRow(
      'boot-restore-sentinel',
      processEnvironment !== undefined && hasExactBootRestoreSentinel(processEnvironment),
    ),
  ]
  const ready = validUser && checks.every((check) => check.status === 'pass')
  if (
    !ready ||
    identity === undefined ||
    source === undefined ||
    ubuntuVersion === undefined ||
    tmux === undefined ||
    linger === undefined ||
    enabled === undefined ||
    active === undefined
  ) {
    return { ready: false, host: null, checks }
  }
  return {
    ready: true,
    host: normalizeHost({
      ...identity,
      source,
      systemd: {
        unit: SYSTEMD_UNIT,
        enabled: enabled.stdout.trim(),
        active: active.stdout.trim(),
        mainPid: mainPidValue,
        bootRestoreSentinel: true,
      },
      ubuntuVersion,
      nodeVersion: process.version,
      tmuxVersion: tmux.stdout.trim(),
      linger: linger.stdout.trim().toLowerCase(),
    }),
    checks,
  }
}

async function inspectHost() {
  const preflight = await inspectHostPreflight()
  if (!preflight.ready || preflight.host === null) throw new Error('Ubuntu host is not ready')
  return preflight.host
}

function ledgerTextList(value, label, maximum = 4_096) {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    !value.every(
      (entry) => typeof entry === 'string' && entry.length <= 4_096 && !hasAsciiControl(entry),
    )
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function validateLedgerRecord(id, value) {
  if (!/^luban-[a-z0-9][a-z0-9_.-]{0,57}$/u.test(id) || !isRecord(value)) {
    throw new Error('keepalive ledger contains an invalid session')
  }
  const { spec, session, checkpoint } = value
  if (!isRecord(spec) || !isRecord(session)) {
    throw new Error('keepalive ledger contains an invalid record')
  }
  const purposes = ['dsh-main', 'task', 'build']
  const owner = spec.ownerTaskId
  if (spec.args !== undefined) ledgerTextList(spec.args, 'session args')
  if (
    spec.id !== id ||
    !purposes.includes(spec.purpose) ||
    typeof spec.command !== 'string' ||
    spec.command === '' ||
    hasAsciiControl(spec.command) ||
    (owner !== undefined &&
      (typeof owner !== 'string' || owner === '' || hasAsciiControl(owner))) ||
    session.id !== id ||
    !purposes.includes(session.purpose) ||
    session.purpose !== spec.purpose ||
    !['tmux', 'service'].includes(session.kind) ||
    typeof session.host !== 'string' ||
    session.host === '' ||
    hasAsciiControl(session.host) ||
    session.ownerTaskId !== owner
  ) {
    throw new Error('keepalive ledger contains an inconsistent record')
  }
  nonNegativeInteger(session.createdAt, 'managed session creation time')
  if (checkpoint === undefined) return
  if (!isRecord(checkpoint) || owner === undefined || checkpoint.taskId !== owner) {
    throw new Error('keepalive ledger contains an unowned checkpoint')
  }
  const steps = ledgerTextList(checkpoint.stepList, 'checkpoint steps', 256)
  ledgerTextList(checkpoint.artifacts, 'checkpoint artifacts')
  nonNegativeInteger(checkpoint.currentStep, 'checkpoint current step')
  nonNegativeInteger(checkpoint.savedAt, 'checkpoint saved time')
  if (checkpoint.currentStep > steps.length) {
    throw new Error('keepalive ledger checkpoint exceeds its plan')
  }
}

function validateLedgerRoot(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.sessions)) {
    throw new Error('keepalive ledger is invalid')
  }
  exactKeys(value, ['schemaVersion', 'sessions', 'updatedAt'], 'keepalive ledger')
  nonNegativeInteger(value.updatedAt, 'ledger updatedAt')
  if (Object.keys(value.sessions).length > 4_096) throw new Error('keepalive ledger is too large')
  for (const [id, record] of Object.entries(value.sessions)) validateLedgerRecord(id, record)
  return value
}

async function readLedgerUnlocked(path) {
  try {
    return validateLedgerRoot(await readJson(path, MAX_LEDGER_BYTES))
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return { schemaVersion: 1, sessions: {}, updatedAt: 0 }
    }
    throw error
  }
}

async function writeLedgerUnlocked(path, value) {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryStats = await lstat(directory)
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error('ledger directory is unsafe')
  }
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  const serialized = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (serialized.byteLength > MAX_LEDGER_BYTES) throw new Error('ledger exceeds its size limit')
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(serialized)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function withLedgerLock(path, operation) {
  const lockPath = `${path}.lock`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 5_000
  let handle
  while (handle === undefined && Date.now() <= deadline) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
    }
  }
  if (handle === undefined) throw new Error('keepalive ledger is busy')
  const identity = await handle.stat()
  let operationResult
  let operationError
  try {
    await handle.writeFile(`${String(process.pid)}\n${String(Date.now())}\n`, 'utf8')
    const ledger = await readLedgerUnlocked(path)
    const result = await operation(ledger)
    if (result.write === true) await writeLedgerUnlocked(path, result.ledger)
    operationResult = result.value
  } catch (error) {
    operationError = error
  }
  let closeError
  let cleanupError
  try {
    await handle.close()
  } catch (error) {
    closeError = error
  }
  try {
    const current = await lstat(lockPath)
    if (sameIdentity(identity, current)) await rm(lockPath)
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') cleanupError = error
  }
  if (operationError !== undefined) throw operationError
  if (closeError !== undefined) throw closeError
  if (cleanupError !== undefined) throw cleanupError
  return operationResult
}

function expectedRecord(marker) {
  return {
    spec: {
      id: marker.sessionId,
      purpose: 'task',
      command: process.execPath,
      args: [
        RUNNER_PATH,
        '__heartbeat-worker',
        '--run-dir',
        marker.runDir,
        '--run-id',
        marker.runId,
      ],
      ownerTaskId: marker.taskId,
    },
    session: {
      id: marker.sessionId,
      host: hostname(),
      kind: 'tmux',
      purpose: 'task',
      ownerTaskId: marker.taskId,
      createdAt: marker.createdAt,
    },
    checkpoint: {
      taskId: marker.taskId,
      stepList: STEP_LIST,
      currentStep: 1,
      artifacts: [join(marker.runDir, 'heartbeat.json')],
      savedAt: marker.createdAt,
    },
  }
}

function validateOwnedRecord(value, marker) {
  if (
    !isRecord(value) ||
    !isRecord(value.spec) ||
    !isRecord(value.session) ||
    !isRecord(value.checkpoint)
  ) {
    throw new Error('owned ledger record is invalid')
  }
  const expected = expectedRecord(marker)
  exactKeys(value, ['spec', 'session', 'checkpoint'], 'owned ledger record')
  exactKeys(value.spec, ['id', 'purpose', 'command', 'args', 'ownerTaskId'], 'owned session spec')
  exactKeys(
    value.session,
    ['id', 'host', 'kind', 'purpose', 'ownerTaskId', 'createdAt'],
    'owned managed session',
  )
  exactKeys(
    value.checkpoint,
    ['taskId', 'stepList', 'currentStep', 'artifacts', 'savedAt'],
    'owned checkpoint',
  )
  if (
    value.spec.id !== expected.spec.id ||
    value.spec.purpose !== expected.spec.purpose ||
    value.spec.command !== expected.spec.command ||
    !isDeepStrictEqual(value.spec.args, expected.spec.args) ||
    value.spec.ownerTaskId !== expected.spec.ownerTaskId ||
    value.session.id !== expected.session.id ||
    value.session.kind !== 'tmux' ||
    value.session.host !== expected.session.host ||
    value.session.purpose !== 'task' ||
    value.session.ownerTaskId !== marker.taskId ||
    value.checkpoint.taskId !== marker.taskId ||
    !isDeepStrictEqual(value.checkpoint.stepList, STEP_LIST) ||
    !isDeepStrictEqual(value.checkpoint.artifacts, expected.checkpoint.artifacts)
  ) {
    throw new Error('owned ledger record changed identity')
  }
  nonNegativeInteger(value.session.createdAt, 'managed session creation time')
  nonNegativeInteger(value.checkpoint.savedAt, 'checkpoint time')
  if (
    !Number.isSafeInteger(value.checkpoint.currentStep) ||
    value.checkpoint.currentStep < 1 ||
    value.checkpoint.currentStep > STEP_LIST.length
  ) {
    throw new Error('owned checkpoint is invalid')
  }
  return value
}

async function inspectTmux(marker, allowMissing = false) {
  const result = await capture(
    'tmux',
    [
      'list-panes',
      '-s',
      '-t',
      `=${marker.sessionId}`,
      '-F',
      '#{session_name}\t#{session_id}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_start_command}',
    ],
    { acceptedExitCodes: allowMissing ? [0, 1] : [0] },
  )
  if (result.exitCode !== 0) return null
  const lines = result.stdout.trimEnd().split(/\r?\n/u)
  if (lines.length !== 1) throw new Error('owned tmux session has an unexpected pane count')
  const [sessionName, tmuxSessionId, paneId, panePid, paneDead, paneCommand] = lines[0].split('\t')
  if (paneDead !== '0' || paneCommand === undefined) throw new Error('owned tmux pane is not alive')
  return normalizeTmux(
    {
      sessionName,
      tmuxSessionId,
      paneId,
      panePid: Number(panePid),
      commandSha256: tmuxPaneCommandSha256(paneCommand, marker.commandSha256),
    },
    marker,
  )
}

async function destroyOwnedTmux(marker) {
  const tmux = await inspectTmux(marker, true)
  if (tmux === null) return
  await capture('tmux', ['kill-session', '-t', tmux.tmuxSessionId])
  if ((await inspectTmux(marker, true)) !== null) throw new Error('tmux cleanup did not finish')
}

async function readHeartbeat(marker) {
  return normalizeHeartbeat(await readJson(join(marker.runDir, 'heartbeat.json')), marker)
}

async function waitForHeartbeat(marker) {
  const deadline = Date.now() + 10_000
  while (Date.now() <= deadline) {
    try {
      return await readHeartbeat(marker)
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') {
        if (Date.now() + 100 > deadline) throw error
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
  }
  throw new Error('heartbeat did not start')
}

async function inspectOwnedFixture(marker) {
  const [tmux, heartbeat, ledger] = await Promise.all([
    inspectTmux(marker),
    readHeartbeat(marker),
    withLedgerLock(marker.ledgerPath, async (root) => ({
      write: false,
      ledger: root,
      value: root,
    })),
  ])
  const record = validateOwnedRecord(ledger.sessions[marker.sessionId], marker)
  return {
    tmux,
    heartbeat,
    ledger: {
      sessionId: marker.sessionId,
      ownerTaskId: marker.taskId,
      sessionCreatedAt: record.session.createdAt,
      checkpoint: {
        taskId: marker.taskId,
        stepList: STEP_LIST,
        currentStep: record.checkpoint.currentStep,
        savedAt: record.checkpoint.savedAt,
      },
    },
  }
}

async function removeHeartbeat(marker) {
  const path = join(marker.runDir, 'heartbeat.json')
  try {
    const heartbeat = normalizeHeartbeat(await readJson(path), marker)
    if (heartbeat.runId !== marker.runId) throw new Error('heartbeat ownership changed')
    await rm(path)
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error
  }
}

async function cleanupOwnedFixture(marker) {
  await withLedgerLock(marker.ledgerPath, async (root) => {
    const record = root.sessions[marker.sessionId]
    if (record !== undefined) validateOwnedRecord(record, marker)
    await destroyOwnedTmux(marker)
    if (record === undefined) return { write: false, ledger: root, value: undefined }
    const sessions = Object.fromEntries(
      Object.entries(root.sessions).filter(([id]) => id !== marker.sessionId),
    )
    return {
      write: true,
      ledger: { schemaVersion: 1, sessions, updatedAt: Date.now() },
      value: undefined,
    }
  })
  await removeHeartbeat(marker)

  const tmuxMissing = (await inspectTmux(marker, true)) === null
  const ledgerMissing = await withLedgerLock(marker.ledgerPath, async (root) => {
    const record = root.sessions[marker.sessionId]
    if (record !== undefined) validateOwnedRecord(record, marker)
    return { write: false, ledger: root, value: record === undefined }
  })
  let heartbeatMissing = false
  try {
    await readHeartbeat(marker)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') heartbeatMissing = true
    else throw error
  }
  if (!tmuxMissing || !ledgerMissing || !heartbeatMissing) {
    throw new Error('owned fixture cleanup postcondition did not pass')
  }
  return { sessionMissing: true, ledgerMissing: true, heartbeatMissing: true }
}

function defaultOperator() {
  return {
    async preflight({ ledgerPath }) {
      const host = await inspectHostPreflight()
      let ledgerReady = true
      try {
        await readLedgerUnlocked(ledgerPath)
      } catch {
        ledgerReady = false
      }
      return {
        ...host,
        ready: host.ready && ledgerReady,
        checks: [...host.checks, preflightRow('ledger', ledgerReady)],
      }
    },
    async prepare(marker) {
      try {
        await withLedgerLock(marker.ledgerPath, async (root) => {
          const existing = root.sessions[marker.sessionId]
          if (existing !== undefined) {
            validateOwnedRecord(existing, marker)
            return { write: false, ledger: root, value: undefined }
          }
          if ((await inspectTmux(marker, true)) !== null) {
            throw new Error('same-name tmux session exists without the owned ledger record')
          }
          await capture('tmux', [
            'new-session',
            '-d',
            '-s',
            marker.sessionId,
            '--',
            posixCommand(markerCommand(marker.runDir, marker.runId)),
          ])
          await waitForHeartbeat(marker)
          const record = expectedRecord(marker)
          return {
            write: true,
            ledger: {
              schemaVersion: 1,
              sessions: { ...root.sessions, [marker.sessionId]: record },
              updatedAt: Date.now(),
            },
            value: undefined,
          }
        })
        return { host: await inspectHost(), fixture: await inspectOwnedFixture(marker) }
      } catch (error) {
        try {
          await cleanupOwnedFixture(marker)
        } catch {
          throw new Error('prepare failed and the exact-owned rollback did not complete')
        }
        throw error
      }
    },
    async inspect(marker) {
      return { host: await inspectHost(), fixture: await inspectOwnedFixture(marker) }
    },
    async advance(marker, expectedStep, nextStep) {
      await withLedgerLock(marker.ledgerPath, async (root) => {
        const record = validateOwnedRecord(root.sessions[marker.sessionId], marker)
        if (record.checkpoint.currentStep !== expectedStep || nextStep !== expectedStep + 1) {
          throw new Error('checkpoint is not at the expected acceptance stage')
        }
        return {
          write: true,
          ledger: {
            schemaVersion: 1,
            sessions: {
              ...root.sessions,
              [marker.sessionId]: {
                ...record,
                checkpoint: { ...record.checkpoint, currentStep: nextStep, savedAt: Date.now() },
              },
            },
            updatedAt: Date.now(),
          },
          value: undefined,
        }
      })
      return { host: await inspectHost(), fixture: await inspectOwnedFixture(marker) }
    },
    async attach(marker) {
      const tmux = await inspectTmux(marker)
      await capture('tmux', ['attach-session', '-t', tmux.tmuxSessionId], {
        inherit: true,
        timeoutMs: ATTACH_TIMEOUT_MS,
        maximum: 1,
      })
      return { attached: true, detached: true }
    },
    async cleanup(marker) {
      return await cleanupOwnedFixture(marker)
    },
  }
}

function expectedStage(command) {
  return {
    'verify-disconnect': 'prepared',
    'observe-attach': 'disconnect-verified',
    'arm-reboot': 'attach-observed',
    'verify-reboot': 'reboot-armed',
  }[command]
}

function commandCompleted(command, stage) {
  const target = {
    'verify-disconnect': 'disconnect-verified',
    'observe-attach': 'attach-observed',
    'arm-reboot': 'reboot-armed',
    'verify-reboot': 'reboot-verified',
  }[command]
  return STAGES.indexOf(stage) >= STAGES.indexOf(target)
}

/** Run one M03 Ubuntu acceptance stage without ever crossing a human disconnect/reboot boundary. */
export async function runM03UbuntuKeepaliveAcceptance(argv, injectedDependencies) {
  const dependencies = injectedDependencies ?? {}
  let parsed
  try {
    parsed = parseCli(argv)
  } catch {
    return safeFailure('E_INVALID_INPUT', 'Invalid M03 Ubuntu acceptance arguments')
  }
  if (parsed.help) return { exitCode: 0, output: HELP.trimEnd() }
  if (
    parsed.command === 'plan' ||
    (!parsed.apply && ['prepare', 'cleanup'].includes(parsed.command))
  ) {
    return planEnvelope(parsed)
  }
  const platform = dependencies.platform ?? process.platform
  if (platform !== 'linux') {
    return safeFailure('E_PLATFORM_UNSUPPORTED', 'M03 Ubuntu acceptance is Linux-only')
  }
  const now = dependencies.now ?? Date.now
  const operator = dependencies.operator ?? defaultOperator()
  const evidenceKind = injectedDependencies === undefined ? 'operator-attested' : 'simulated'

  try {
    await assertExternalPath(dirname(parsed.ledger), 'ledger directory', true)
    if (parsed.command === 'preflight') {
      const result = await operator.preflight({ ledgerPath: parsed.ledger, unit: SYSTEMD_UNIT })
      const ready = result.ready === true
      const host = ready ? normalizeHost(result.host) : null
      const checks = normalizePreflightChecks(result.checks, ready)
      return {
        exitCode: ready ? 0 : 2,
        output: JSON.stringify({
          schemaVersion: 1,
          ok: ready,
          mode: 'read-only',
          scope: SCOPE,
          acceptancePassed: false,
          host,
          checks,
          ledgerPathSha256: sha256(parsed.ledger),
          safety: safetyBoundary(),
        }),
      }
    }

    const runDir = parsed.runDir
    if (runDir === undefined) throw new Error('run directory is unavailable')
    if (parsed.command === 'prepare') {
      let run
      try {
        run = await loadRun(runDir)
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error
      }
      if (run !== undefined) {
        if (run.marker.evidenceKind !== evidenceKind || run.marker.ledgerPath !== parsed.ledger) {
          throw new Error('existing run belongs to another execution identity')
        }
        if (run.latest !== null) return currentResult(run.marker, run.latest, runDir, true)
      } else {
        const preflight = await operator.preflight({
          ledgerPath: parsed.ledger,
          unit: SYSTEMD_UNIT,
        })
        if (preflight.ready !== true) throw new Error('Ubuntu keepalive preflight is not ready')
        const host = normalizeHost(preflight.host)
        const marker = markerFor({
          runDir,
          ledgerPath: parsed.ledger,
          evidenceKind,
          source: host.source,
          host,
          now: now(),
        })
        await createRunDirectory(runDir, marker)
        run = { marker, latest: null, latestSha256: null }
      }
      const prepared = await operator.prepare(run.marker)
      const observedAt = now()
      const host = normalizeHost(prepared.host)
      const fixture = normalizeFixture(prepared.fixture, run.marker, observedAt)
      assertSnapshot(host, fixture, run.marker)
      if (fixture.ledger.checkpoint.currentStep !== 1)
        throw new Error('prepare checkpoint is invalid')
      const evidence = evidenceFor({
        marker: run.marker,
        previous: null,
        previousSha256: null,
        stage: 'prepared',
        host,
        fixture,
        observations: pendingObservations(),
        now: observedAt,
      })
      await appendEvidence(runDir, evidence, run.marker, null, null)
      return currentResult(run.marker, evidence, runDir)
    }

    if (parsed.command === 'cleanup') {
      const marker = await loadOwnerMarker(runDir)
      if (marker.evidenceKind !== evidenceKind || marker.ledgerPath !== parsed.ledger) {
        throw new Error('existing run belongs to another execution identity')
      }
      let chain
      try {
        chain = await readEvidenceChain(runDir, marker)
      } catch {
        chain = undefined
      }
      const result = await operator.cleanup(marker)
      if (
        result.sessionMissing !== true ||
        result.ledgerMissing !== true ||
        result.heartbeatMissing !== true
      ) {
        throw new Error('cleanup was not verified')
      }
      if (chain?.latest === undefined || chain.latest === null) {
        return cleanupRecoveryResult(marker, runDir)
      }
      if (chain.latest.stage === 'cleaned') {
        return currentResult(marker, chain.latest, runDir, true)
      }
      try {
        const evidence = cleanedEvidence({
          previous: chain.latest,
          previousSha256: chain.latestSha256,
          now: now(),
        })
        await appendEvidence(runDir, evidence, marker, chain.latest, chain.latestSha256)
        return currentResult(marker, evidence, runDir)
      } catch {
        return cleanupRecoveryResult(marker, runDir, 'cleanup-evidence-publication-failed')
      }
    }

    const run = await loadRun(runDir)
    if (
      run.marker.evidenceKind !== evidenceKind ||
      run.marker.ledgerPath !== parsed.ledger ||
      run.latest === null
    ) {
      throw new Error('acceptance run identity is invalid')
    }
    if (run.latest.stage === 'cleaned') throw new Error('acceptance run is already cleaned')
    if (commandCompleted(parsed.command, run.latest.stage)) {
      return currentResult(run.marker, run.latest, runDir, true)
    }
    if (run.latest.stage !== expectedStage(parsed.command)) {
      throw new Error('acceptance stage is out of order')
    }

    let snapshot = await operator.inspect(run.marker)
    const observedAt = now()
    let host = normalizeHost(snapshot.host)
    let fixture = normalizeFixture(snapshot.fixture, run.marker, observedAt)
    assertSnapshot(host, fixture, run.marker)
    if (!isDeepStrictEqual(host.source, run.latest.binding.source)) {
      throw new Error('source identity changed during acceptance')
    }
    let observations = run.latest.observations
    let stage

    if (parsed.command === 'verify-disconnect') {
      if (
        host.bootId !== run.latest.binding.preparedBootId ||
        fixture.ledger.checkpoint.currentStep !== 1 ||
        !matchesPreparedRuntime(host, fixture, run.latest.binding) ||
        fixture.heartbeat.sequence <= run.latest.latest.fixture.heartbeat.sequence ||
        fixture.heartbeat.observedAt <= run.latest.latest.fixture.heartbeat.observedAt
      ) {
        throw new Error('same-boot heartbeat and tmux continuity were not observed')
      }
      observations = {
        ...observations,
        disconnect: await readDisconnectWitness(parsed.witness, run.marker, run.latest, observedAt),
      }
      snapshot = await operator.advance(run.marker, 1, 2)
      stage = 'disconnect-verified'
    } else if (parsed.command === 'observe-attach') {
      if (
        host.bootId !== run.latest.binding.preparedBootId ||
        fixture.ledger.checkpoint.currentStep !== 2 ||
        !matchesPreparedRuntime(host, fixture, run.latest.binding)
      ) {
        throw new Error('attach observation is not on the prepared boot')
      }
      const beforeHeartbeat = fixture.heartbeat
      const attached = await operator.attach(run.marker)
      if (attached.attached !== true || attached.detached !== true) {
        throw new Error('real tmux attach/detach was not observed')
      }
      snapshot = await operator.inspect(run.marker)
      host = normalizeHost(snapshot.host)
      fixture = normalizeFixture(snapshot.fixture, run.marker, now())
      assertSnapshot(host, fixture, run.marker)
      if (
        host.bootId !== run.latest.binding.preparedBootId ||
        !matchesPreparedRuntime(host, fixture, run.latest.binding) ||
        fixture.heartbeat.sequence <= beforeHeartbeat.sequence
      ) {
        throw new Error('tmux attachment did not retain the owned live pane')
      }
      observations = { ...observations, attach: { status: 'pass', observedAt: now() } }
      snapshot = await operator.advance(run.marker, 2, 3)
      stage = 'attach-observed'
    } else if (parsed.command === 'arm-reboot') {
      if (
        host.bootId !== run.latest.binding.preparedBootId ||
        fixture.ledger.checkpoint.currentStep !== 3 ||
        !matchesPreparedRuntime(host, fixture, run.latest.binding)
      ) {
        throw new Error('reboot arm state is invalid')
      }
      observations = {
        ...observations,
        reboot: {
          status: 'armed',
          armedAt: observedAt,
          bootId: host.bootId,
          mainPid: host.systemd.mainPid,
        },
      }
      snapshot = await operator.advance(run.marker, 3, 4)
      stage = 'reboot-armed'
    } else {
      if (
        observations.reboot.status !== 'armed' ||
        host.bootId === observations.reboot.bootId ||
        host.bootId === run.latest.binding.preparedBootId ||
        fixture.heartbeat.bootId !== host.bootId ||
        fixture.heartbeat.startedAt <= observations.reboot.armedAt ||
        fixture.ledger.sessionCreatedAt <= observations.reboot.armedAt ||
        fixture.ledger.checkpoint.currentStep !== 4
      ) {
        throw new Error('post-reboot continuation was not observed')
      }
      observations = {
        ...observations,
        reboot: {
          status: 'pass',
          armedAt: observations.reboot.armedAt,
          armedBootId: observations.reboot.bootId,
          verifiedAt: observedAt,
          verifiedBootId: host.bootId,
          mainPid: host.systemd.mainPid,
        },
      }
      snapshot = await operator.advance(run.marker, 4, 5)
      stage = 'reboot-verified'
    }

    const finalObservedAt = now()
    host = normalizeHost(snapshot.host)
    fixture = normalizeFixture(snapshot.fixture, run.marker, finalObservedAt)
    assertSnapshot(host, fixture, run.marker)
    const expectedCheckpoint = STAGES.indexOf(stage) + 1
    if (fixture.ledger.checkpoint.currentStep !== expectedCheckpoint) {
      throw new Error('checkpoint did not advance with the evidence stage')
    }
    const evidence = evidenceFor({
      marker: run.marker,
      previous: run.latest,
      previousSha256: run.latestSha256,
      stage,
      host,
      fixture,
      observations,
      now: finalObservedAt,
    })
    await appendEvidence(runDir, evidence, run.marker, run.latest, run.latestSha256)
    return currentResult(run.marker, evidence, runDir)
  } catch {
    return safeFailure('E_ACCEPTANCE_REQUIRED', 'M03 Ubuntu acceptance stage did not pass')
  }
}

async function writeHeartbeat(marker, startedAt, sequence) {
  const identity = await readSystemIdentity()
  const heartbeat = {
    schemaVersion: HEARTBEAT_SCHEMA,
    runId: marker.runId,
    ...identity,
    pid: process.pid,
    sequence,
    startedAt,
    observedAt: Date.now(),
  }
  const path = join(marker.runDir, 'heartbeat.json')
  try {
    const current = await readJson(path)
    normalizeHeartbeat(current, marker)
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error
  }
  const temporary = join(marker.runDir, `.heartbeat.${randomUUID()}.tmp`)
  await writeJsonNew(temporary, heartbeat)
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function runHeartbeatWorker(argv) {
  const parsed = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      'run-dir': { type: 'string' },
      'run-id': { type: 'string' },
    },
  })
  if (parsed.positionals.length !== 0) throw new Error('invalid heartbeat worker arguments')
  const runDir = pathInput(parsed.values['run-dir'], 'heartbeat run directory')
  await assertExternalPath(runDir, 'heartbeat run directory', true)
  const marker = validateMarker(await readJson(join(runDir, 'owner.json')), runDir)
  if (parsed.values['run-id'] !== marker.runId) throw new Error('heartbeat run id is invalid')
  const startedAt = Date.now()
  let sequence = 0
  let stopping = false
  const stop = () => {
    stopping = true
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    while (!stopping) {
      sequence += 1
      await writeHeartbeat(marker, startedAt, sequence)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))
    }
  } finally {
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
}

function isMain() {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isMain()) {
  if (process.argv[2] === '__heartbeat-worker') {
    try {
      await runHeartbeatWorker(process.argv.slice(3))
    } catch {
      process.exitCode = 1
    }
  } else {
    const result = await runM03UbuntuKeepaliveAcceptance(process.argv.slice(2))
    process.stdout.write(`${result.output}\n`)
    process.exitCode = result.exitCode
  }
}
