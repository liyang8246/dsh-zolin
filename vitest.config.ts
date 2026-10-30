import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: join(tmpdir(), 'dsh-zolin-vitest', basename(process.cwd())),
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
