import { mkdir, open, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { LubanError } from 'dsh-luban-core'
import type { CommandResult, CommandRunner } from './command-runner.js'
import { assertSuccess } from './command-runner.js'
import { managedSessionId, windowsArguments } from './session-id.js'

export const WINDOWS_HOST_TASK_NAME = '\\dsh-luban-host'
export const WINDOWS_SESSION_TASK_PREFIX = '\\dsh-luban-session-'

const HOST_DESCRIPTION = 'dsh-luban Windows deployment host launcher v1'
const SESSION_DESCRIPTION = 'dsh-luban Windows runtime child session v1'
const SID_PATTERN = /^S-\d(?:-\d+)+$/iu
const MISSING_PATTERN = /cannot find|not found|does not exist|找不到|不存在|系统找不到/iu
const EXECUTION_TRIGGER_TAGS = [
  'BootTrigger',
  'CalendarTrigger',
  'EventTrigger',
  'IdleTrigger',
  'LogonTrigger',
  'RegistrationTrigger',
  'SessionStateChangeTrigger',
  'TimeTrigger',
] as const

export type WindowsTaskTrigger = 'boot' | 'on-demand'
export type WindowsTaskState = 'missing' | 'exact' | 'conflict'

export interface WindowsTaskDefinition {
  readonly name: string
  readonly description: string
  readonly principalSid: string
  readonly trigger: WindowsTaskTrigger
  readonly command: string
  readonly arguments: string
}

export interface WindowsHostAcceptanceLaunch {
  readonly runDir: string
  readonly runId: string
  readonly specSha256: string
}

export interface WindowsHostLaunch {
  readonly nodeExecutable: string
  readonly bootstrapPath: string
  readonly dshEntry: string
  readonly dshHome: string
  readonly profile: 'win-debug'
  readonly acceptance?: WindowsHostAcceptanceLaunch
}

export interface WindowsTaskRepositoryOptions {
  readonly runner: CommandRunner
  readonly timeoutMs: number
  readonly currentUser?: string
  readonly currentUserSid?: string
  readonly temporaryDirectory?: string
  readonly signal?: AbortSignal
}

export interface WindowsTaskQuery {
  readonly state: 'missing' | 'present'
  readonly xml?: string
}

function validCurrentUser(value: string): string {
  const normalized = value.trim()
  if (normalized === '' || normalized.includes('\0') || /[\r\n]/u.test(normalized)) {
    throw new LubanError('E_INVALID_INPUT', 'current Windows user is invalid')
  }
  return normalized
}

function validSid(value: string): string {
  if (!SID_PATTERN.test(value)) {
    throw new LubanError('E_INVALID_INPUT', 'current Windows user SID is invalid')
  }
  return value.toUpperCase()
}

function validAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be an absolute path`)
  }
  return value
}

function validAcceptanceLaunch(
  value: WindowsHostAcceptanceLaunch | undefined,
): WindowsHostAcceptanceLaunch | undefined {
  if (value === undefined) return undefined
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value.runId) ||
    !/^[a-f0-9]{64}$/u.test(value.specSha256)
  ) {
    throw new LubanError('E_INVALID_INPUT', 'Windows acceptance launch identity is invalid')
  }
  return {
    runDir: validAbsolutePath(value.runDir, 'Windows acceptance run directory'),
    runId: value.runId,
    specSha256: value.specSha256,
  }
}

function xmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

interface XmlElement {
  readonly full: string
  readonly attributes: Readonly<Record<string, string>>
  readonly inner: string
}

function parseAttributes(value: string): Readonly<Record<string, string>> | null {
  const attributes: Record<string, string> = {}
  const expression = /\s*([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/guy
  let offset = 0
  while (offset < value.length) {
    expression.lastIndex = offset
    const match = expression.exec(value)
    if (match?.index !== offset || match[1] === undefined) return null
    const key = match[1]
    if (Object.hasOwn(attributes, key)) return null
    attributes[key] = decodeXmlText(match[2] ?? match[3] ?? '')
    offset = expression.lastIndex
  }
  return attributes
}

function openingTagCount(xml: string, tag: string): number {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s|>|\\/)`, 'giu'))].length
}

function singleElement(xml: string, tag: string): XmlElement | null {
  if (openingTagCount(xml, tag) !== 1) return null
  const expression = new RegExp(`<${tag}([^<>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, 'iu')
  const match = expression.exec(xml)
  if (match?.[0] === undefined || match[1] === undefined || match[2] === undefined) return null
  const attributes = parseAttributes(match[1])
  if (attributes === null) return null
  return { full: match[0], attributes, inner: match[2] }
}

function exactAttributes(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(actual)
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key): boolean => actual[key] === expected[key])
  )
}

function textChild(
  parent: string,
  tag: string,
): { readonly full: string; readonly value: string } | null {
  const element = singleElement(parent, tag)
  if (
    element === null ||
    !exactAttributes(element.attributes, {}) ||
    /<[^>]+>/u.test(element.inner)
  ) {
    return null
  }
  return { full: element.full, value: decodeXmlText(element.inner.trim()) }
}

function exactTextChildren(parent: string, expected: Readonly<Record<string, string>>): boolean {
  let remainder = parent
  for (const [tag, value] of Object.entries(expected)) {
    const child = textChild(parent, tag)
    if (child?.value.toLocaleLowerCase('en-US') !== value.toLocaleLowerCase('en-US')) {
      return false
    }
    remainder = remainder.replace(child.full, '')
  }
  return remainder.trim() === ''
}

function sameWindowsValue(left: string | null, right: string): boolean {
  return left?.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
}

function csvFields(line: string): readonly string[] {
  const fields: string[] = []
  const pattern = /(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/gu
  for (const match of line.trim().matchAll(pattern)) {
    fields.push((match[1] ?? match[2] ?? '').replaceAll('""', '"'))
  }
  return fields
}

function isMissing(result: CommandResult): boolean {
  return result.exitCode !== 0 && MISSING_PATTERN.test(`${result.stdout}\n${result.stderr}`)
}

function hasOnlyExpectedTrigger(xml: string, trigger: WindowsTaskTrigger): boolean {
  const counts = EXECUTION_TRIGGER_TAGS.map((tag): readonly [string, number] => [
    tag,
    openingTagCount(xml, tag),
  ])
  if (trigger === 'on-demand') {
    return (
      counts.every(([, count]): boolean => count === 0) && openingTagCount(xml, 'Triggers') === 0
    )
  }
  if (
    counts.some(([tag, count]): boolean => count !== (tag === 'BootTrigger' ? 1 : 0)) ||
    openingTagCount(xml, 'Triggers') !== 1
  ) {
    return false
  }
  const triggers = singleElement(xml, 'Triggers')
  const boot = triggers === null ? null : singleElement(triggers.inner, 'BootTrigger')
  return (
    triggers !== null &&
    boot !== null &&
    exactAttributes(triggers.attributes, {}) &&
    exactAttributes(boot.attributes, {}) &&
    triggers.inner.replace(boot.full, '').trim() === '' &&
    exactTextChildren(boot.inner, { Enabled: 'true' })
  )
}

export function windowsSessionTaskName(id: string): string {
  return `${WINDOWS_SESSION_TASK_PREFIX}${managedSessionId(id)}`
}

function assertManagedTaskName(name: string): void {
  if (name.toLocaleLowerCase('en-US') === WINDOWS_HOST_TASK_NAME.toLocaleLowerCase('en-US')) return
  const prefix = WINDOWS_SESSION_TASK_PREFIX.toLocaleLowerCase('en-US')
  if (!name.toLocaleLowerCase('en-US').startsWith(prefix)) {
    throw new LubanError('E_INVALID_INPUT', 'Windows task is outside the managed namespace')
  }
  const id = name.slice(WINDOWS_SESSION_TASK_PREFIX.length)
  if (windowsSessionTaskName(id).toLocaleLowerCase('en-US') !== name.toLocaleLowerCase('en-US')) {
    throw new LubanError('E_INVALID_INPUT', 'Windows task name is invalid')
  }
}

export function hostTaskDefinition(
  principalSid: string,
  launch: WindowsHostLaunch,
): WindowsTaskDefinition {
  const nodeExecutable = validAbsolutePath(launch.nodeExecutable, 'Windows host Node executable')
  const bootstrapPath = validAbsolutePath(launch.bootstrapPath, 'Windows host bootstrap')
  const dshEntry = validAbsolutePath(launch.dshEntry, 'Windows host DSH entry')
  const dshHome = validAbsolutePath(launch.dshHome, 'Windows host DSH home')
  const acceptance = validAcceptanceLaunch(launch.acceptance)
  return {
    name: WINDOWS_HOST_TASK_NAME,
    description: HOST_DESCRIPTION,
    principalSid: validSid(principalSid),
    trigger: 'boot',
    command: nodeExecutable,
    arguments: windowsArguments([
      bootstrapPath,
      '--dsh-entry',
      dshEntry,
      '--dsh-home',
      dshHome,
      '--profile',
      launch.profile,
      ...(acceptance === undefined
        ? []
        : [
            '--acceptance-run-dir',
            acceptance.runDir,
            '--acceptance-run-id',
            acceptance.runId,
            '--acceptance-spec-sha256',
            acceptance.specSha256,
          ]),
    ]),
  }
}

export function childTaskDefinition(input: {
  readonly id: string
  readonly principalSid: string
  readonly command: string
  readonly arguments: string
}): WindowsTaskDefinition {
  if (
    input.command === '' ||
    input.command.includes('\0') ||
    /[\r\n]/u.test(input.command) ||
    input.arguments.includes('\0') ||
    /[\r\n]/u.test(input.arguments)
  ) {
    throw new LubanError('E_INVALID_INPUT', 'Windows child command is invalid')
  }
  return {
    name: windowsSessionTaskName(input.id),
    description: SESSION_DESCRIPTION,
    principalSid: validSid(input.principalSid),
    trigger: 'on-demand',
    command: input.command,
    arguments: input.arguments,
  }
}

export function renderWindowsTaskXml(definition: WindowsTaskDefinition): string {
  const trigger =
    definition.trigger === 'boot'
      ? [
          '  <Triggers>',
          '    <BootTrigger>',
          '      <Enabled>true</Enabled>',
          '    </BootTrigger>',
          '  </Triggers>',
        ]
      : []
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlText(definition.description)}</Description>`,
    '  </RegistrationInfo>',
    ...trigger,
    '  <Principals>',
    '    <Principal id="CurrentUser">',
    `      <UserId>${xmlText(definition.principalSid)}</UserId>`,
    '      <LogonType>S4U</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>3</Count>',
    '    </RestartOnFailure>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="CurrentUser">',
    '    <Exec>',
    `      <Command>${xmlText(definition.command)}</Command>`,
    ...(definition.arguments === ''
      ? []
      : [`      <Arguments>${xmlText(definition.arguments)}</Arguments>`]),
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n')
}

const EXPECTED_SETTINGS = Object.freeze({
  MultipleInstancesPolicy: 'IgnoreNew',
  DisallowStartIfOnBatteries: 'false',
  StopIfGoingOnBatteries: 'false',
  AllowHardTerminate: 'true',
  StartWhenAvailable: 'true',
  RunOnlyIfNetworkAvailable: 'false',
  AllowStartOnDemand: 'true',
  Enabled: 'true',
  Hidden: 'false',
  RunOnlyIfIdle: 'false',
  WakeToRun: 'false',
  ExecutionTimeLimit: 'PT0S',
  Priority: '7',
})

function exactSettings(value: string): boolean {
  const restart = singleElement(value, 'RestartOnFailure')
  if (
    restart === null ||
    !exactAttributes(restart.attributes, {}) ||
    !exactTextChildren(restart.inner, { Interval: 'PT1M', Count: '3' })
  ) {
    return false
  }
  return exactTextChildren(value.replace(restart.full, ''), EXPECTED_SETTINGS)
}

interface WindowsTaskProjection {
  readonly description: string
  readonly principalSid: string
  readonly command: string
  readonly arguments: string
}

function projectWindowsTaskXml(
  xml: string,
  trigger: WindowsTaskTrigger,
): WindowsTaskProjection | null {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) return null
  const task = singleElement(xml, 'Task')
  if (task === null || !hasOnlyExpectedTrigger(task.inner, trigger)) return null

  const registration = singleElement(task.inner, 'RegistrationInfo')
  const description = registration === null ? null : textChild(registration.inner, 'Description')
  const principals = singleElement(task.inner, 'Principals')
  const principal = principals === null ? null : singleElement(principals.inner, 'Principal')
  if (
    registration === null ||
    description === null ||
    principals === null ||
    principal === null ||
    !exactAttributes(principals.attributes, {}) ||
    !exactAttributes(principal.attributes, { id: 'CurrentUser' }) ||
    principals.inner.replace(principal.full, '').trim() !== ''
  ) {
    return null
  }
  const userId = textChild(principal.inner, 'UserId')
  const logonType = textChild(principal.inner, 'LogonType')
  const runLevel = textChild(principal.inner, 'RunLevel')
  if (
    userId === null ||
    logonType?.value.toUpperCase() !== 'S4U' ||
    runLevel?.value.toLocaleLowerCase('en-US') !== 'leastprivilege' ||
    !exactTextChildren(principal.inner, {
      UserId: userId.value,
      LogonType: 'S4U',
      RunLevel: 'LeastPrivilege',
    })
  ) {
    return null
  }

  const settings = singleElement(task.inner, 'Settings')
  if (
    settings === null ||
    !exactAttributes(settings.attributes, {}) ||
    !exactSettings(settings.inner)
  ) {
    return null
  }

  const actions = singleElement(task.inner, 'Actions')
  const exec = actions === null ? null : singleElement(actions.inner, 'Exec')
  if (
    actions === null ||
    exec === null ||
    !exactAttributes(actions.attributes, { Context: 'CurrentUser' }) ||
    !exactAttributes(exec.attributes, {}) ||
    actions.inner.replace(exec.full, '').trim() !== ''
  ) {
    return null
  }
  const command = textChild(exec.inner, 'Command')
  const argumentElement =
    openingTagCount(exec.inner, 'Arguments') === 0 ? null : textChild(exec.inner, 'Arguments')
  if (command === null || command.value === '') return null
  let actionRemainder = exec.inner.replace(command.full, '')
  if (argumentElement !== null) actionRemainder = actionRemainder.replace(argumentElement.full, '')
  if (actionRemainder.trim() !== '') return null
  return {
    description: description.value,
    principalSid: userId.value,
    command: command.value,
    arguments: argumentElement?.value ?? '',
  }
}

export function matchesWindowsTaskXml(xml: string, definition: WindowsTaskDefinition): boolean {
  const projection = projectWindowsTaskXml(xml, definition.trigger)
  return (
    projection !== null &&
    projection.description === definition.description &&
    sameWindowsValue(projection.principalSid, definition.principalSid) &&
    sameWindowsValue(projection.command, definition.command) &&
    projection.arguments === definition.arguments
  )
}

export function isManagedChildTaskXml(xml: string, principalSid: string): boolean {
  const projection = projectWindowsTaskXml(xml, 'on-demand')
  return (
    projection !== null &&
    projection.description === SESSION_DESCRIPTION &&
    sameWindowsValue(projection.principalSid, validSid(principalSid))
  )
}

/** Bounded Scheduled Tasks operations shared by host and child lifecycle owners. */
export class WindowsTaskRepository {
  readonly #runner: CommandRunner
  readonly #timeoutMs: number
  readonly #currentUser: string
  readonly #temporaryDirectory: string
  readonly #signal: AbortSignal | undefined
  #currentUserSid: string | undefined

  public constructor(options: WindowsTaskRepositoryOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new LubanError('E_INVALID_INPUT', 'Windows task timeout must be positive')
    }
    this.#runner = options.runner
    this.#timeoutMs = options.timeoutMs
    this.#currentUser = validCurrentUser(options.currentUser ?? userInfo().username)
    this.#currentUserSid =
      options.currentUserSid === undefined ? undefined : validSid(options.currentUserSid)
    this.#temporaryDirectory = options.temporaryDirectory ?? tmpdir()
    this.#signal = options.signal
  }

  public get currentUser(): string {
    return this.#currentUser
  }

  public async principalSid(): Promise<string> {
    if (this.#currentUserSid !== undefined) return this.#currentUserSid
    const result = await this.#run('whoami.exe', ['/user', '/fo', 'csv', '/nh'])
    assertSuccess(result, 'resolve current Windows user SID')
    const fields = csvFields(result.stdout.split(/\r?\n/u)[0] ?? '')
    const account = fields[0]
    const sid = fields[1]
    if (account === undefined || sid === undefined || !SID_PATTERN.test(sid)) {
      throw new LubanError('E_UNAVAILABLE', 'Unable to resolve the current Windows user SID')
    }
    const expected = this.#currentUser.toLocaleLowerCase('en-US')
    const actual = account.toLocaleLowerCase('en-US')
    if (actual !== expected && !actual.endsWith(`\\${expected}`)) {
      throw new LubanError('E_INVALID_INPUT', 'Windows task user does not match the current user')
    }
    this.#currentUserSid = validSid(sid)
    return this.#currentUserSid
  }

  public async query(name: string): Promise<WindowsTaskQuery> {
    assertManagedTaskName(name)
    const result = await this.#run('schtasks.exe', ['/Query', '/TN', name, '/XML'])
    if (isMissing(result)) return { state: 'missing' }
    if (result.exitCode !== 0 && !(await this.#taskExists(name))) return { state: 'missing' }
    assertSuccess(result, 'query Windows scheduled task')
    return { state: 'present', xml: result.stdout }
  }

  public async inspect(definition: WindowsTaskDefinition): Promise<WindowsTaskState> {
    const query = await this.query(definition.name)
    if (query.state === 'missing') return 'missing'
    return matchesWindowsTaskXml(query.xml ?? '', definition) ? 'exact' : 'conflict'
  }

  public async create(definition: WindowsTaskDefinition): Promise<void> {
    assertManagedTaskName(definition.name)
    await mkdir(this.#temporaryDirectory, { recursive: true, mode: 0o700 })
    const path = join(this.#temporaryDirectory, `.dsh-luban-task-${randomUUID()}.xml`)
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(renderWindowsTaskXml(definition), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error: unknown) {
      await rm(path, { force: true }).catch((): void => undefined)
      throw new LubanError('E_IO', 'Unable to stage the Windows scheduled task', { cause: error })
    }
    try {
      const result = await this.#run('schtasks.exe', [
        '/Create',
        '/TN',
        definition.name,
        '/XML',
        path,
      ])
      assertSuccess(result, 'register Windows scheduled task')
    } finally {
      await rm(path, { force: true })
    }
  }

  /** Create once, or safely reuse an exact task won by a concurrent installer. */
  public async createOrReuse(definition: WindowsTaskDefinition): Promise<'created' | 'reused'> {
    try {
      await this.create(definition)
      return 'created'
    } catch (error: unknown) {
      if ((await this.inspect(definition)) === 'exact') return 'reused'
      throw error
    }
  }

  public async runTask(name: string): Promise<void> {
    assertManagedTaskName(name)
    assertSuccess(
      await this.#run('schtasks.exe', ['/Run', '/TN', name]),
      'start Windows scheduled task',
    )
  }

  public async isRunning(name: string): Promise<boolean> {
    assertManagedTaskName(name)
    const taskName = this.#rootTaskName(name)
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$task = Get-ScheduledTask -TaskPath '\\' -TaskName '${taskName.replaceAll("'", "''")}'`,
      "if ($task.State -eq 'Running') { [Console]::Out.Write('running') } else { [Console]::Out.Write('stopped') }",
    ].join('; ')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const result = await this.#run('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encoded,
    ])
    assertSuccess(result, 'probe Windows scheduled task')
    const state = result.stdout.trim().toLocaleLowerCase('en-US')
    if (state !== 'running' && state !== 'stopped') {
      throw new LubanError('E_UNAVAILABLE', 'Windows scheduled task returned an invalid state')
    }
    return state === 'running'
  }

  public async waitUntilRunning(name: string, attempts = 20, intervalMs = 100): Promise<void> {
    if (!Number.isSafeInteger(attempts) || attempts <= 0) {
      throw new LubanError('E_INVALID_INPUT', 'Windows task probe attempts must be positive')
    }
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
      throw new LubanError('E_INVALID_INPUT', 'Windows task probe interval must be non-negative')
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.isRunning(name)) return
      if (attempt + 1 < attempts) {
        await delay(intervalMs, undefined, { signal: this.#signal })
      }
    }
    throw new LubanError('E_UNAVAILABLE', 'Windows scheduled task did not reach Running state', {
      retriable: true,
    })
  }

  public async isElevated(): Promise<boolean> {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
      '$principal = [Security.Principal.WindowsPrincipal]::new($identity)',
      '$role = [Security.Principal.WindowsBuiltInRole]::Administrator',
      "if ($principal.IsInRole($role)) { [Console]::Out.Write('elevated') } else { [Console]::Out.Write('standard') }",
    ].join('; ')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const result = await this.#run('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encoded,
    ])
    assertSuccess(result, 'probe Windows elevation')
    const state = result.stdout.trim().toLocaleLowerCase('en-US')
    if (state !== 'elevated' && state !== 'standard') {
      throw new LubanError('E_UNAVAILABLE', 'Windows elevation probe returned an invalid state')
    }
    return state === 'elevated'
  }

  public async endAndDelete(name: string, owns: (xml: string) => boolean): Promise<void> {
    assertManagedTaskName(name)
    const initial = await this.query(name)
    if (initial.state === 'missing') return
    if (!owns(initial.xml ?? '')) {
      throw new LubanError('E_INVALID_INPUT', 'Refusing to delete an unmanaged Windows task')
    }
    const ended = await this.#run('schtasks.exe', ['/End', '/TN', name])
    if (ended.exitCode !== 0 && !isMissing(ended) && (await this.isRunning(name))) {
      assertSuccess(ended, 'stop Windows scheduled task')
    }
    const beforeDelete = await this.query(name)
    if (beforeDelete.state === 'missing') return
    if (!owns(beforeDelete.xml ?? '')) {
      throw new LubanError('E_INVALID_INPUT', 'Windows task ownership changed before deletion')
    }
    if (await this.isRunning(name)) {
      throw new LubanError('E_UNAVAILABLE', 'Windows scheduled task is still running after stop')
    }
    const deleted = await this.#run('schtasks.exe', ['/Delete', '/TN', name, '/F'])
    if (deleted.exitCode !== 0 && !isMissing(deleted) && (await this.#taskExists(name))) {
      assertSuccess(deleted, 'delete Windows scheduled task')
    }
    if ((await this.query(name)).state !== 'missing') {
      throw new LubanError('E_IO', 'Windows scheduled task still exists after deletion')
    }
  }

  public async listCsv(): Promise<string> {
    const result = await this.#run('schtasks.exe', ['/Query', '/FO', 'CSV', '/NH'])
    assertSuccess(result, 'list Windows scheduled tasks')
    return result.stdout
  }

  async #taskExists(name: string): Promise<boolean> {
    const result = await this.#run('schtasks.exe', ['/Query', '/FO', 'CSV', '/NH'])
    assertSuccess(result, 'list Windows scheduled tasks')
    const expected = name.toLocaleLowerCase('en-US')
    return result.stdout.split(/\r?\n/u).some((line): boolean => {
      const taskName = csvFields(line)[0]
      return taskName?.toLocaleLowerCase('en-US') === expected
    })
  }

  #rootTaskName(name: string): string {
    if (!name.startsWith('\\') || name.slice(1).includes('\\') || name.length < 2) {
      throw new LubanError('E_INVALID_INPUT', 'Windows task must use the managed root namespace')
    }
    return name.slice(1)
  }

  async #run(command: string, args: readonly string[]): Promise<CommandResult> {
    return await this.#runner.run(command, args, {
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: 16 * 1024,
      signal: this.#signal,
    })
  }
}
