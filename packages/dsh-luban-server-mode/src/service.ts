import type {
  ArtifactRef,
  BuildJob,
  BuildJobInput,
  ResourceReport,
  ServerModeService,
} from '@luban/core'
import type { BuildTemplateConfig } from './config.js'
import type { BuildQueue, BuildQueueEvent } from './queue.js'
import type { UserSystemdInstaller } from './systemd.js'

export class DefaultServerModeService implements ServerModeService {
  readonly #installer: UserSystemdInstaller
  readonly #queue: BuildQueue

  public constructor(installer: UserSystemdInstaller, queue: BuildQueue) {
    this.#installer = installer
    this.#queue = queue
  }

  public install(options: {
    readonly user: string
    readonly profile: 'ubuntu-server'
  }): Promise<void> {
    return this.#installer.install(options.user, options.profile)
  }

  public uninstall(): Promise<void> {
    return this.#installer.uninstall()
  }

  public enqueue(input: BuildJobInput): Promise<BuildJob> {
    return this.#queue.enqueue(input)
  }

  public queue(): Promise<readonly BuildJob[]> {
    return this.#queue.queue()
  }

  public artifacts(jobId: string): Promise<readonly ArtifactRef[]> {
    return this.#queue.artifacts(jobId)
  }

  public resourceReport(): Promise<ResourceReport> {
    return this.#queue.resourceReport()
  }

  public get(jobId: string): Promise<BuildJob> {
    return this.#queue.get(jobId)
  }

  public errorExcerpt(jobId: string): Promise<string | null> {
    return this.#queue.errorExcerpt(jobId)
  }

  public templates(): readonly BuildTemplateConfig[] {
    return this.#queue.templates()
  }

  public subscribe(listener: (event: BuildQueueEvent) => void): () => void {
    return this.#queue.subscribe(listener)
  }

  public start(): Promise<void> {
    return this.#queue.start()
  }

  public dispose(): Promise<void> {
    return this.#queue.dispose()
  }
}
