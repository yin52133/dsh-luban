import { mkdir, statfs } from 'node:fs/promises'
import { loadavg } from 'node:os'

export interface ResourceSample {
  readonly diskFreeGb: number
  readonly load1: number
}

export interface ResourceProbe {
  sample(): Promise<ResourceSample>
}

export class NodeResourceProbe implements ResourceProbe {
  readonly #directory: string

  public constructor(directory: string) {
    this.#directory = directory
  }

  public async sample(): Promise<ResourceSample> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    const disk = await statfs(this.#directory)
    return {
      diskFreeGb: (disk.bavail * disk.bsize) / 1024 ** 3,
      load1: loadavg()[0] ?? 0,
    }
  }
}
