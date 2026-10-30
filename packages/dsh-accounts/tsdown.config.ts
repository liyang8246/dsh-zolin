import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  clean: true,
  dts: false,
  sourcemap: false,
  deps: {
    alwaysBundle: [/.*/],
  },
})
