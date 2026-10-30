import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'uv-run': 'src/uv-run/index.ts',
    'restrict': 'src/restrict.ts',
  },
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
