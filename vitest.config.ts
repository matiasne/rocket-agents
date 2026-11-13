import { defineConfig } from 'vitest/config'

// Unit tests cover the modules that need no running server: the escalation contract and the
// router's roll-up and cap rules.
export default defineConfig({
  test: {
    include: ['servers/shared/escalation/**/*.test.ts', 'servers/router/src/mastra/escalation/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.mastra/**', '.next/**'],
  },
})
