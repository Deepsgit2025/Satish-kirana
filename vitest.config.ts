import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Workspaces import `@ssbazar/shared` by package name. Point that at the
 * package source so tests run without a build step.
 */
const alias = {
  '@ssbazar/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
};

function workspaceProject(name: string, root: string) {
  return {
    resolve: { alias },
    test: {
      name,
      root,
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
}

export default defineConfig({
  test: {
    projects: [
      workspaceProject('shared', './packages/shared'),
      workspaceProject('server', './server'),
      workspaceProject('counter', './apps/counter'),
      workspaceProject('office', './apps/office'),
    ],
  },
});
