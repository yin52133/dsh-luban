import type {
  AccountId,
  AccountSessionRegistry,
  ChannelAdapter,
  ChannelEndpoint,
  ChannelHandle,
  ChannelKind,
  ExecResult,
  OpenOptions,
  SessionId,
  SnippetFile,
  SnippetRange,
  WinDebugService,
} from '@yin52133/dsh-luban-core'
import { LubanError } from '@yin52133/dsh-luban-core'
import { AndroidChannelAdapter, AndroidService } from './android.js'
import {
  createGdbChannel,
  createSshChannel,
  NodeSocketConnector,
  TcpChannelAdapter,
  type SocketConnector,
} from './channels.js'
import { NodeCommandRunner, NodeManagedProcessRunner } from './command-runner.js'
import type { Config } from './config.js'
import { DesktopMcpManager, type DesktopToolRegistry } from './desktop-mcp.js'
import { DeviceExecutionGate } from './device-gate.js'
import { GdbSessionManager, type GdbSnapshotRequest, type GdbStartRequest } from './gdb.js'
import { HotplugWatcher } from './hotplug.js'
import type { DesktopMcpClient } from './mcp-stdio.js'
import { ChannelHub } from './monitor.js'
import { OptionalSerialPortProvider, SerialChannelAdapter } from './serial.js'
import { SnippetStore } from './snippet-store.js'
import { CommandTemplateRegistry, type TemplateExecutionPreflight } from './templates.js'
import type {
  AndroidDevice,
  CommandRunner,
  FilterOptions,
  GdbSnapshot,
  ManagedChannel,
  ManagedProcessRunner,
  SerialProvider,
  SessionInjection,
  TemplateExecutionArtifact,
  TemplateRunResult,
  WinDebugEvent,
} from './types.js'

export interface WinDebugDependencies {
  readonly commands?: CommandRunner
  readonly processes?: ManagedProcessRunner
  readonly serial?: SerialProvider
  readonly sockets?: SocketConnector
  readonly sessionInjection?: SessionInjection
  readonly accountSessions?: AccountSessionRegistry
  readonly adapters?: readonly ChannelAdapter[]
  readonly desktopMcp?: DesktopMcpClient
}

/** L3 assembly implementing every channel through the one @yin52133/dsh-luban-core contract. */
export class DefaultWinDebugService implements WinDebugService {
  readonly #hub: ChannelHub
  readonly #templates: CommandTemplateRegistry
  readonly #android: AndroidService
  readonly #gdb: GdbSessionManager
  readonly #mcp: DesktopMcpManager
  readonly #snippets: SnippetStore
  readonly #injection: SessionInjection | undefined
  readonly #accountSessions: AccountSessionRegistry | undefined
  readonly #hotplug: HotplugWatcher | undefined
  readonly #detachHotplug: (() => void) | undefined
  #started = false

  public constructor(config: Config, dependencies: WinDebugDependencies = {}) {
    const commands = dependencies.commands ?? new NodeCommandRunner()
    const processes = dependencies.processes ?? new NodeManagedProcessRunner()
    const snippets = new SnippetStore(config.snippet)
    const adb = new AndroidChannelAdapter('adb', commands, config)
    const fastboot = new AndroidChannelAdapter('fastboot', commands, config)
    const serial = new SerialChannelAdapter(
      dependencies.serial ?? new OptionalSerialPortProvider(),
      config.serial.defaultBaud,
    )
    const sockets = dependencies.sockets ?? new NodeSocketConnector()
    const adapters = dependencies.adapters ?? [
      serial,
      adb,
      fastboot,
      createGdbChannel(config, commands),
      createSshChannel(config, commands),
      new TcpChannelAdapter('telnet', config.remote, sockets),
      new TcpChannelAdapter('tcp-serial', config.remote, sockets),
    ]
    const configuredSerial = adapters.find(
      (adapter): adapter is SerialChannelAdapter => adapter instanceof SerialChannelAdapter,
    )
    const executionGate = new DeviceExecutionGate({
      activeChannels: (): readonly ManagedChannel[] => this.#hub.active(),
      ...(configuredSerial === undefined ? {} : { serial: configuredSerial }),
      preflightTimeoutMs: Math.min(config.execution.startupTimeoutMs, config.execution.timeoutMs),
    })
    const hub = new ChannelHub({
      adapters,
      snippetStore: snippets,
      maxLines: config.snippet.maxLines,
      timestamp: config.serial.timestamp,
      openPreflight: (endpoint, signal) => executionGate.acquireChannel(endpoint, signal),
    })
    this.#hub = hub
    const preflight: TemplateExecutionPreflight = (invocation, signal) =>
      executionGate.acquire(invocation, signal)
    const templates = new CommandTemplateRegistry(config, commands, undefined, preflight)
    this.#templates = templates
    this.#snippets = snippets
    this.#android = new AndroidService(adb, fastboot)
    this.#gdb = new GdbSessionManager({
      config,
      templates,
      commands,
      processes,
      snippets,
      preflight,
    })
    this.#mcp = new DesktopMcpManager(config, dependencies.desktopMcp, dependencies.accountSessions)
    this.#injection = dependencies.sessionInjection
    this.#accountSessions = dependencies.accountSessions
    const serialAdapter = adapters.find((adapter): boolean => adapter.kind === 'serial')
    if (serialAdapter !== undefined) {
      this.#hotplug = new HotplugWatcher(serialAdapter, config.serial.pollIntervalMs)
      this.#detachHotplug = this.#hotplug.subscribe((change): void => {
        this.#hub.publishEndpointChange(change)
      })
    }
  }

  public start(): void {
    if (this.#started) return
    this.#started = true
    this.#hotplug?.start()
  }

  public subscribe(listener: (event: WinDebugEvent) => void): () => void {
    return this.#hub.subscribe(listener)
  }

  public listEndpoints(kind?: ChannelKind): Promise<readonly ChannelEndpoint[]> {
    return this.#hub.listEndpoints(kind)
  }

  public endpointErrors(): Readonly<Record<string, string>> {
    return this.#hub.endpointErrors()
  }

  public activeChannels(accountId: AccountId): readonly ManagedChannel[] {
    return this.#hub.activeFor(accountId)
  }

  public open(
    accountId: AccountId,
    endpointId: string,
    options: OpenOptions = {},
  ): Promise<ManagedChannel> {
    return this.#hub.open(accountId, endpointId, options)
  }

  public close(accountId: AccountId, channelId: string): Promise<void> {
    return this.#hub.close(accountId, channelId)
  }

  public write(accountId: AccountId, channelId: string, data: string): Promise<void> {
    return this.#hub.write(accountId, channelId, data)
  }

  public exec(
    accountId: AccountId,
    channelId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    return this.#hub.exec(accountId, channelId, command, signal)
  }

  public lines(
    accountId: AccountId,
    channelId: string,
    filter: FilterOptions = {},
  ): ReturnType<ChannelHub['lines']> {
    return this.#hub.lines(accountId, channelId, filter)
  }

  public captureSnippet(handle: ChannelHandle, range: SnippetRange): Promise<SnippetFile> {
    return this.#hub.capture(handle, range)
  }

  public captureById(
    accountId: AccountId,
    channelId: string,
    range: SnippetRange,
  ): Promise<SnippetFile> {
    return this.#hub.captureById(accountId, channelId, range)
  }

  public async injectToSession(sessionId: SessionId, snippet: SnippetFile): Promise<void> {
    const accountId = snippet.accountId
    if (accountId === undefined || this.#accountSessions === undefined) {
      throw new LubanError('E_NOT_FOUND', `Session ${sessionId} was not found`)
    }
    if ((await this.#accountSessions.ownerOf(sessionId)) !== accountId) {
      throw new LubanError('E_NOT_FOUND', `Session ${sessionId} was not found`)
    }
    if (this.#injection === undefined) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', 'DSH session injection is unavailable')
    }
    await this.#injection.inject(sessionId, snippet)
  }

  public async captureAndInject(
    accountId: AccountId,
    channelId: string,
    range: SnippetRange,
    sessionId?: SessionId,
  ): Promise<SnippetFile> {
    const snippet = await this.captureById(accountId, channelId, range)
    if (sessionId !== undefined) await this.injectToSession(sessionId, snippet)
    return snippet
  }

  public async runTemplate(
    templateId: string,
    params: Readonly<Record<string, string>>,
  ): Promise<ExecResult> {
    return this.#templates.run(templateId, params)
  }

  public runTemplateDetailed(
    templateId: string,
    params: Readonly<Record<string, string>>,
    confirmation?: string,
    signal?: AbortSignal,
  ): Promise<TemplateRunResult> {
    return this.#templates.run(templateId, params, confirmation, signal)
  }

  public async runTemplateArtifact(
    accountId: AccountId,
    templateId: string,
    params: Readonly<Record<string, string>>,
    confirmation?: string,
    sessionId?: SessionId,
    signal?: AbortSignal,
  ): Promise<TemplateExecutionArtifact> {
    const startedAt = Date.now()
    const result = await this.runTemplateDetailed(templateId, params, confirmation, signal)
    const template = this.#templates
      .list()
      .find((candidate): boolean => candidate.id === templateId)
    if (template === undefined)
      throw new LubanError('E_NOT_FOUND', `Template ${templateId} was not found`)
    const kind: ChannelEndpoint['kind'] =
      template.tool === 'adb' ? 'adb' : template.tool === 'fastboot' ? 'fastboot' : 'gdb'
    const endpoint: ChannelEndpoint = Object.freeze({
      kind,
      id: `template:${template.id}`,
      label: template.title,
      params: Object.freeze({ templateId: template.id, tool: template.tool }),
    })
    const content = [
      `template=${template.id}`,
      `tool=${template.tool}`,
      `exitCode=${String(result.exitCode)}`,
      `durationMs=${String(result.durationMs)}`,
      '',
      ...result.lines.map((line): string => `[${line.level.toUpperCase()}] ${line.text}`),
    ].join('\n')
    const snippet = await this.#snippets.write(accountId, endpoint, content, startedAt, Date.now())
    if (sessionId !== undefined) await this.injectToSession(sessionId, snippet)
    return { accountId, result, snippet, injected: sessionId !== undefined }
  }

  public templates(): ReturnType<CommandTemplateRegistry['list']> {
    return this.#templates.list()
  }

  public androidDevices(): Promise<readonly AndroidDevice[]> {
    return this.#android.devices()
  }

  public gdbStatus(accountId: AccountId): ReturnType<GdbSessionManager['statusFor']> {
    return this.#gdb.statusFor(accountId)
  }

  public gdbStart(
    accountId: AccountId,
    request: GdbStartRequest,
    signal?: AbortSignal,
  ): ReturnType<GdbSessionManager['start']> {
    return this.#gdb.start(accountId, request, signal)
  }

  public async gdbSnapshot(
    accountId: AccountId,
    request: GdbSnapshotRequest,
    sessionId?: SessionId,
  ): Promise<GdbSnapshot> {
    const snapshot = await this.#gdb.snapshot(accountId, request)
    if (sessionId !== undefined) await this.injectToSession(sessionId, snapshot.snippet)
    return snapshot
  }

  public gdbStop(accountId: AccountId): ReturnType<GdbSessionManager['stop']> {
    return this.#gdb.stop(accountId)
  }

  public desktopMcpStatus(accountId: AccountId): ReturnType<DesktopMcpManager['statusFor']> {
    return this.#mcp.statusFor(accountId)
  }

  public desktopMcpDescriptor(): ReturnType<DesktopMcpManager['descriptor']> {
    return this.#mcp.descriptor()
  }

  public registerDesktopMcpTools(registry: DesktopToolRegistry): () => void {
    return this.#mcp.registerTools(registry)
  }

  public desktopMcpStart(
    accountId: AccountId,
    signal?: AbortSignal,
  ): ReturnType<DesktopMcpManager['start']> {
    return this.#mcp.start(accountId, signal)
  }

  public desktopMcpStop(accountId: AccountId): ReturnType<DesktopMcpManager['stop']> {
    return this.#mcp.stop(accountId)
  }

  public async dispose(): Promise<void> {
    const hotplug = this.#hotplug?.stop()
    this.#detachHotplug?.()
    await Promise.allSettled([
      ...(hotplug === undefined ? [] : [hotplug]),
      this.#gdb.forceStop(),
      this.#mcp.forceStop(),
      this.#hub.dispose(),
    ])
  }
}
