import type { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type { AuthService } from 'dsh-luban-core'
import { LubanError, modulePrefix } from 'dsh-luban-core'
import { Config as ConfigSchema, type Config as WinDebugConfig, parseConfig } from './config.js'
import { WinDebugHttpApi } from './http-api.js'
import { DefaultWinDebugService } from './service.js'
import { DshSessionInjection } from './session-injector.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanAuth: AuthService
    agents: AgentRegistry
    lubanWinDebug: DefaultWinDebugService
  }
}

export const name = 'luban-win-debug'
export const inject = ['webServer', 'lubanAuth', 'agents', 'tools']
export const Config = ConfigSchema
export type Config = WinDebugConfig

/** Mount the Windows-only authenticated debug control plane. */
export function apply(ctx: Context, input: unknown = {}): void {
  if (process.platform !== 'win32') {
    throw new LubanError(
      'E_PLATFORM_UNSUPPORTED',
      `dsh-luban-win-debug requires Windows; current platform is ${process.platform}`,
    )
  }
  const config = parseConfig(input)
  const service = new DefaultWinDebugService(config, {
    sessionInjection: new DshSessionInjection(ctx.agents),
    accountSessions: ctx.lubanAuth.accountSessions,
  })
  const api = new WinDebugHttpApi(service, ctx.lubanAuth)
  ctx.provide('lubanWinDebug', service)
  ctx.effect(() => {
    const unregisterTools = service.registerDesktopMcpTools(ctx.tools)
    const unregister = ctx.webServer.register({
      kind: 'prefix',
      path: modulePrefix('win-debug'),
      handler: api.handler,
    })
    service.start()
    return async (): Promise<void> => {
      unregisterTools()
      unregister()
      api.dispose()
      await service.dispose()
    }
  }, 'luban-win-debug: authenticated route, channels and process lifecycle')
}

export {
  AndroidChannelAdapter,
  AndroidService,
  parseAdbDevices,
  parseFastbootDevices,
} from './android.js'
export {
  createGdbChannel,
  createSshChannel,
  NodeSocketConnector,
  StaticCommandChannelAdapter,
  TcpChannelAdapter,
} from './channels.js'
export type { SocketConnection, SocketConnector } from './channels.js'
export { NodeCommandRunner, NodeManagedProcessRunner, parseCommandWords } from './command-runner.js'
export { assertAllowedPath, expandPath, parseConfig } from './config.js'
export type { RemoteEndpointConfig } from './config.js'
export { DesktopMcpManager } from './desktop-mcp.js'
export type { DesktopMcpDescriptor, DesktopToolRegistry } from './desktop-mcp.js'
export { DeviceExecutionGate } from './device-gate.js'
export { GdbSessionManager } from './gdb.js'
export type { GdbOccupancyStatus, GdbSnapshotRequest, GdbStartRequest, GdbStatus } from './gdb.js'
export { HotplugWatcher } from './hotplug.js'
export type { EndpointChange } from './hotplug.js'
export { formatDesktopMcpResult, NodeStdioMcpClient } from './mcp-stdio.js'
export type {
  DesktopMcpCallResult,
  DesktopMcpClient,
  DesktopMcpConnectOptions,
  DesktopMcpProcess,
  DesktopMcpProcessFactory,
} from './mcp-stdio.js'
export { WinDebugHttpApi } from './http-api.js'
export { ChannelHub, filterLines } from './monitor.js'
export type { ChannelOpenPreflight } from './monitor.js'
export { OptionalSerialPortProvider, SerialChannelAdapter } from './serial.js'
export { DefaultWinDebugService } from './service.js'
export type { WinDebugDependencies } from './service.js'
export { DshSessionInjection } from './session-injector.js'
export { SnippetStore } from './snippet-store.js'
export {
  builtInTemplates,
  classifyOutput,
  CommandTemplateRegistry,
  toolForTemplate,
} from './templates.js'
export type { ResolvedInvocation, TemplateExecutionPreflight } from './templates.js'
export type * from './types.js'
