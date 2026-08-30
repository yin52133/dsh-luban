import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/live-acceptance.ts', 'src/live-acceptance-cli.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver', '@luban/core', 'yaml'],
  },
})
