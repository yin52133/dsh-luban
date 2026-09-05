import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: ['yaml', /^react(?:\/|$)/u, /^@deepseek-ai\//u],
  },
})
