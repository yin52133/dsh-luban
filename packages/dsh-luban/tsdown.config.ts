import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  outputOptions: {
    entryFileNames: 'index.js',
  },
})
