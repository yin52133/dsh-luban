import type { ExecResult } from 'dsh-luban-core'
import { LubanError } from 'dsh-luban-core'
import { assertAllowedPath, type Config } from './config.js'
import type {
  CommandRunner,
  CommandTemplate,
  StructuredOutputLine,
  TemplateParameter,
  TemplateRunResult,
  ToolId,
} from './types.js'

export interface ResolvedInvocation {
  readonly template: CommandTemplate
  readonly command: string
  readonly args: readonly string[]
  readonly params: Readonly<Record<string, string>>
  readonly cwd?: string
}

export type TemplateExecutionPreflight = (
  invocation: ResolvedInvocation,
  signal?: AbortSignal,
) => Promise<() => void>

const BUILT_INS: readonly CommandTemplate[] = Object.freeze([
  {
    id: 'openocd-flash',
    title: 'OpenOCD · program, verify and reset',
    tool: 'openocd',
    category: 'flash',
    args: [
      '-f',
      '{interfaceConfig}',
      '-f',
      '{targetConfig}',
      '-c',
      'program {{firmware}} verify reset exit',
    ],
    params: [path('interfaceConfig'), path('targetConfig'), path('firmware')],
  },
  {
    id: 'openocd-reset',
    title: 'OpenOCD · reset target',
    tool: 'openocd',
    category: 'reset',
    args: ['-f', '{interfaceConfig}', '-f', '{targetConfig}', '-c', 'init; reset run; shutdown'],
    params: [path('interfaceConfig'), path('targetConfig')],
  },
  {
    id: 'openocd-server',
    title: 'OpenOCD · GDB server',
    tool: 'openocd',
    category: 'debug',
    args: ['-f', '{interfaceConfig}', '-f', '{targetConfig}', '-c', 'gdb_port {gdbPort}'],
    params: [path('interfaceConfig'), path('targetConfig'), integer('gdbPort')],
  },
  {
    id: 'jlink-script',
    title: 'J-Link · run allowlisted commander script',
    tool: 'jlink',
    category: 'flash',
    args: [
      '-Device',
      '{device}',
      '-If',
      '{interface}',
      '-Speed',
      '{speed}',
      '-CommanderScript',
      '{script}',
    ],
    params: [token('device'), token('interface'), integer('speed'), path('script')],
  },
  {
    id: 'esptool-flash',
    title: 'esptool · write image',
    tool: 'esptool',
    category: 'flash',
    args: [
      '--chip',
      '{chip}',
      '--port',
      '{port}',
      '--baud',
      '{baud}',
      'write_flash',
      '{address}',
      '{firmware}',
    ],
    params: [token('chip'), port('port'), integer('baud'), hex('address'), path('firmware')],
  },
  {
    id: 'esptool-erase',
    title: 'esptool · erase device',
    tool: 'esptool',
    category: 'flash',
    destructive: true,
    confirmation: 'ERASE_DEVICE',
    args: ['--chip', '{chip}', '--port', '{port}', 'erase_flash'],
    params: [token('chip'), port('port')],
  },
  {
    id: 'stm32-flash',
    title: 'STM32CubeProgrammer · program, verify and reset',
    tool: 'stm32cubeprogrammer',
    category: 'flash',
    args: ['-c', 'port={probe}', '-w', '{firmware}', '-v', '-rst'],
    params: [token('probe'), path('firmware')],
  },
  {
    id: 'stm32-reset',
    title: 'STM32CubeProgrammer · reset',
    tool: 'stm32cubeprogrammer',
    category: 'reset',
    args: ['-c', 'port={probe}', '-rst'],
    params: [token('probe')],
  },
  {
    id: 'fastboot-flash',
    title: 'fastboot · flash partition',
    tool: 'fastboot',
    category: 'android',
    destructive: true,
    confirmation: 'FLASH_DEVICE',
    args: ['-s', '{device}', 'flash', '{partition}', '{image}'],
    params: [token('device'), token('partition'), path('image')],
  },
  {
    id: 'fastboot-reboot',
    title: 'fastboot · reboot',
    tool: 'fastboot',
    category: 'android',
    args: ['-s', '{device}', 'reboot'],
    params: [token('device')],
  },
  {
    id: 'adb-reboot-bootloader',
    title: 'adb · reboot to bootloader',
    tool: 'adb',
    category: 'android',
    args: ['-s', '{device}', 'reboot', 'bootloader'],
    params: [token('device')],
  },
])

function parameter(name: string, kind: TemplateParameter['kind']): TemplateParameter {
  return Object.freeze({ name, kind, required: true })
}

function token(name: string): TemplateParameter {
  return parameter(name, 'token')
}

function integer(name: string): TemplateParameter {
  return parameter(name, 'integer')
}

function hex(name: string): TemplateParameter {
  return parameter(name, 'hex')
}

function path(name: string): TemplateParameter {
  return parameter(name, 'path')
}

function port(name: string): TemplateParameter {
  return parameter(name, 'port')
}

function safeToken(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u.test(value)) {
    throw new LubanError('E_INVALID_INPUT', `${label} is not a safe token`)
  }
  return value
}

function normalizeParameter(value: string, spec: TemplateParameter, config: Config): string {
  if (value.length > 4096 || value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new LubanError('E_INVALID_INPUT', `${spec.name} is invalid`)
  }
  switch (spec.kind) {
    case 'token':
    case 'symbol':
      return safeToken(value, spec.name)
    case 'integer': {
      if (!/^\d{1,10}$/u.test(value) || Number(value) > 0x7fff_ffff) {
        throw new LubanError('E_INVALID_INPUT', `${spec.name} must be a bounded integer`)
      }
      return value
    }
    case 'hex':
      if (!/^0x[0-9A-Fa-f]{1,16}$/u.test(value)) {
        throw new LubanError('E_INVALID_INPUT', `${spec.name} must be hexadecimal`)
      }
      return value
    case 'port':
      if (!/^COM\d{1,3}$/iu.test(value) && !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
        throw new LubanError('E_INVALID_INPUT', `${spec.name} is not a safe port`)
      }
      return value
    case 'path': {
      if (/[;{}"'`]/u.test(value)) {
        throw new LubanError(
          'E_INVALID_INPUT',
          `${spec.name} contains command-language metacharacters`,
        )
      }
      return assertAllowedPath(value, config, spec.name)
    }
  }
}

function validateTemplate(template: CommandTemplate): void {
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(template.id)) throw new TypeError('template id is invalid')
  const names = new Set(template.params.map((item): string => item.name))
  if (names.size !== template.params.length)
    throw new TypeError(`${template.id} has duplicate parameters`)
  for (const argument of template.args) {
    if (argument.includes('\0') || /\r|\n/u.test(argument))
      throw new TypeError(`${template.id} has an invalid argument`)
    for (const match of argument.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)) {
      const name = match[1]
      if (name === undefined || !names.has(name))
        throw new TypeError(`${template.id} references an unknown parameter`)
    }
  }
  if (template.destructive === true && template.confirmation === undefined) {
    throw new TypeError(`${template.id} needs an explicit confirmation phrase`)
  }
}

export function classifyOutput(result: ExecResult): readonly StructuredOutputLine[] {
  const entries: StructuredOutputLine[] = []
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    const level: StructuredOutputLine['level'] = /\b(?:error|failed|fatal|denied|cannot)\b/iu.test(
      line,
    )
      ? 'error'
      : /\b(?:warn|retry|deprecated)\b/iu.test(line)
        ? 'warning'
        : 'info'
    entries.push({ level, text: line.slice(0, 16_384) })
  }
  if (result.exitCode !== 0 && !entries.some((line): boolean => line.level === 'error')) {
    entries.push({ level: 'error', text: `Process exited with code ${String(result.exitCode)}` })
  }
  return entries
}

/** Strict template registry: executable and argument shapes are config-time allowlists. */
export class CommandTemplateRegistry {
  readonly #config: Config
  readonly #runner: CommandRunner
  readonly #templates = new Map<string, CommandTemplate>()
  readonly #preflight: TemplateExecutionPreflight | undefined

  public constructor(
    config: Config,
    runner: CommandRunner,
    templates: readonly CommandTemplate[] = BUILT_INS,
    preflight?: TemplateExecutionPreflight,
  ) {
    this.#config = config
    this.#runner = runner
    this.#preflight = preflight
    for (const template of templates) this.register(template)
  }

  public register(template: CommandTemplate): () => void {
    validateTemplate(template)
    if (this.#templates.has(template.id))
      throw new TypeError(`template ${template.id} is duplicated`)
    this.#templates.set(template.id, Object.freeze({ ...template }))
    return (): void => {
      this.#templates.delete(template.id)
    }
  }

  public list(): readonly CommandTemplate[] {
    return [...this.#templates.values()]
  }

  public resolve(
    templateId: string,
    params: Readonly<Record<string, string>>,
    confirmation?: string,
  ): ResolvedInvocation {
    const template = this.#templates.get(templateId)
    if (template === undefined)
      throw new LubanError('E_NOT_FOUND', `Template ${templateId} was not found`)
    if (template.destructive === true && confirmation !== template.confirmation) {
      throw new LubanError(
        'E_INVALID_INPUT',
        `Template ${templateId} requires confirmation phrase ${template.confirmation ?? ''}`,
      )
    }
    const specs = new Map(
      template.params.map((item): readonly [string, TemplateParameter] => [item.name, item]),
    )
    for (const name of Object.keys(params)) {
      if (!specs.has(name))
        throw new LubanError('E_INVALID_INPUT', `Unknown template parameter ${name}`)
    }
    const values = new Map<string, string>()
    for (const spec of template.params) {
      const raw = params[spec.name]
      if ((raw === undefined || raw === '') && spec.required !== false) {
        throw new LubanError('E_INVALID_INPUT', `Template parameter ${spec.name} is required`)
      }
      if (raw !== undefined && raw !== '')
        values.set(spec.name, normalizeParameter(raw, spec, this.#config))
    }
    const args = template.args.map((argument): string =>
      argument.replace(
        /\{([A-Za-z][A-Za-z0-9_]*)\}/gu,
        (_whole: string, name: string): string => values.get(name) ?? '',
      ),
    )
    return {
      template,
      command: this.#config.tools[template.tool],
      args,
      params: Object.freeze(Object.fromEntries(values)),
      ...(this.#config.execution.cwd === undefined ? {} : { cwd: this.#config.execution.cwd }),
    }
  }

  public async run(
    templateId: string,
    params: Readonly<Record<string, string>>,
    confirmation?: string,
    signal?: AbortSignal,
  ): Promise<TemplateRunResult> {
    const invocation = this.resolve(templateId, params, confirmation)
    const release = await this.#preflight?.(invocation, signal)
    let result: ExecResult
    try {
      result = await this.#runner.run(invocation.command, invocation.args, {
        timeoutMs: this.#config.execution.timeoutMs,
        maxOutputBytes: this.#config.execution.maxOutputBytes,
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
        ...(signal === undefined ? {} : { signal }),
      })
    } finally {
      release?.()
    }
    return {
      ...result,
      templateId,
      outcome: result.exitCode === 0 ? 'ok' : 'failed',
      lines: classifyOutput(result),
    }
  }
}

export function builtInTemplates(): readonly CommandTemplate[] {
  return BUILT_INS
}

export function toolForTemplate(template: CommandTemplate): ToolId {
  return template.tool
}
