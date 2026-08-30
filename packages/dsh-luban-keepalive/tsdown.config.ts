import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', 'windows-operator-cli': 'src/windows-operator-cli.ts' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
  deps: { neverBundle: [/^@deepseek-ai\//u, /^dsh-luban-core$/u] },
})
