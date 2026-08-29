import type {
  ChannelDataEvent,
  ChannelEndpoint,
  ChannelHandle,
  ChannelKind,
  ExecResult,
  SnippetFile,
} from '@luban/core'

export type ToolId =
  'openocd' | 'jlink' | 'esptool' | 'stm32cubeprogrammer' | 'gdb' | 'adb' | 'fastboot' | 'ssh'

export interface CommandOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly cwd?: string
  readonly maxOutputBytes: number
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options: CommandOptions): Promise<ExecResult>
}

export interface ManagedProcessEvent {
  readonly type: 'stdout' | 'stderr' | 'exit'
  readonly text?: string
  readonly exitCode?: number
  readonly at: number
}

export interface ManagedProcess {
  readonly pid: number | undefined
  events(): AsyncIterable<ManagedProcessEvent>
  stop(): Promise<ExecResult>
}

export interface ManagedProcessOptions extends CommandOptions {
  readonly startupTimeoutMs: number
}

export interface ManagedProcessRunner {
  start(
    command: string,
    args: readonly string[],
    options: ManagedProcessOptions,
  ): Promise<ManagedProcess>
}

export interface SerialPortDescriptor {
  readonly path: string
  readonly manufacturer?: string
  readonly serialNumber?: string
  readonly vendorId?: string
  readonly productId?: string
}

export interface SerialConnection {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  onData(listener: (data: Uint8Array) => void): () => void
  onStatus(listener: (status: 'closed' | 'error', detail?: string) => void): () => void
}

export interface SerialProvider {
  list(): Promise<readonly SerialPortDescriptor[]>
  open(path: string, baudRate: number, signal?: AbortSignal): Promise<SerialConnection>
}

export interface ChannelLine {
  readonly sequence: number
  readonly channelId: string
  readonly endpoint: ChannelEndpoint
  readonly text: string
  readonly at: number
}

export type WinDebugEvent =
  | { readonly type: 'line'; readonly line: ChannelLine }
  | {
      readonly type: 'channel-status'
      readonly channelId: string
      readonly endpoint: ChannelEndpoint
      readonly event: ChannelDataEvent
    }
  | {
      readonly type: 'endpoints-changed'
      readonly kind: ChannelKind
      readonly added: readonly ChannelEndpoint[]
      readonly removed: readonly ChannelEndpoint[]
      readonly endpoints: readonly ChannelEndpoint[]
    }

export interface ManagedChannel {
  readonly id: string
  readonly endpoint: ChannelEndpoint
  readonly handle: ChannelHandle
  readonly openedAt: number
}

export interface FilterOptions {
  readonly query?: string
  readonly regex?: boolean
  readonly caseSensitive?: boolean
}

export interface TemplateParameter {
  readonly name: string
  readonly kind: 'token' | 'integer' | 'hex' | 'path' | 'port' | 'symbol'
  readonly required?: boolean
}

export interface CommandTemplate {
  readonly id: string
  readonly title: string
  readonly tool: ToolId
  readonly args: readonly string[]
  readonly params: readonly TemplateParameter[]
  readonly destructive?: boolean
  readonly confirmation?: string
  readonly category: 'flash' | 'reset' | 'debug' | 'android'
}

export interface StructuredOutputLine {
  readonly level: 'info' | 'warning' | 'error'
  readonly text: string
}

export interface TemplateRunResult extends ExecResult {
  readonly templateId: string
  readonly outcome: 'ok' | 'failed'
  readonly lines: readonly StructuredOutputLine[]
}

export interface TemplateExecutionArtifact {
  readonly result: TemplateRunResult
  readonly snippet: SnippetFile
  readonly injected: boolean
}

export interface AndroidDevice {
  readonly transport: 'adb' | 'fastboot'
  readonly id: string
  readonly state: 'device' | 'offline' | 'unauthorized' | 'bootloader' | 'unknown'
  readonly detail: Readonly<Record<string, string>>
}

export interface GdbSnapshot {
  readonly id: string
  readonly createdAt: number
  readonly target: string
  readonly breakpoints: readonly string[]
  readonly variables: readonly string[]
  readonly registers: boolean
  readonly result: ExecResult
  readonly snippet: SnippetFile
}

export interface DesktopMcpStatus {
  readonly enabled: boolean
  readonly state: 'disabled' | 'stopped' | 'running'
  readonly commandConfigured: boolean
  readonly tools: readonly string[]
}

export interface SessionInjection {
  inject(sessionId: string, snippet: SnippetFile): Promise<void>
}
