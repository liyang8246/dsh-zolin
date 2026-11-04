import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'uv-run': 'src/uv-run/index.ts',
    'webfetch': 'src/webfetch/index.ts',
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
    // Playwright resolves its driver and browser assets at runtime from its own
    // package directory, so it must stay external.
    neverBundle: ['playwright-core'],
    alwaysBundle: [/.*/],
  },
})
