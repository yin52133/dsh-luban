import type { Clock, SessionId } from '@luban/core'
import type { Config } from '../src/config.js'
import { parseConfig } from '../src/config.js'
import type {
  ClipboardAdapter,
  ImageProcessor,
  SessionImageInjector,
  StoredImage,
} from '../src/types.js'

export const PNG_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)

export class MutableClock implements Clock {
  public constructor(public value: number) {}

  public now(): number {
    return this.value
  }
}

export const passThroughProcessor: ImageProcessor = {
  process(bytes) {
    return Promise.resolve({
      bytes,
      report: {
        status: 'not-needed',
        originalBytes: bytes.byteLength,
        outputBytes: bytes.byteLength,
      },
    })
  },
}

export const emptyClipboard: ClipboardAdapter = {
  capture: () => Promise.reject(new Error('clipboard should not be read')),
}

export function testConfig(workspaceRoot: string, override: Partial<Config> = {}): Config {
  return {
    ...parseConfig({ workspaceRoot, compression: false }),
    ...override,
  }
}

export class RecordingInjector implements SessionImageInjector {
  public readonly calls: {
    readonly sessionId: SessionId
    readonly image: StoredImage
    readonly style: 'markdown' | 'path'
  }[] = []

  public inject(
    sessionId: SessionId,
    image: StoredImage,
    style: 'markdown' | 'path',
  ): Promise<void> {
    this.calls.push({ sessionId, image, style })
    return Promise.resolve()
  }
}
