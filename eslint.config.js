import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

import ssbazar from './tools/eslint-plugin-ssbazar/src/index.js';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { ssbazar },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // CLAUDE.md invariant 19. An error, not a warning: the build has to fail,
      // or the first hundred strings go in the wrong way while everyone means
      // to come back to it (docs/DECISIONS.md D34).
      'ssbazar/no-hardcoded-strings': 'error',
    },
  },
  {
    // Config files are plain JS and sit outside the typed program.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Tests print nothing to a user. `console` in a test is a debugging aid and
    // a fixture is a fixture; neither is text anybody reads in the shop.
    files: ['**/*.test.ts', '**/testing/**/*.ts', 'tools/**/*.js'],
    rules: { 'ssbazar/no-hardcoded-strings': 'off' },
  },
  prettier,
);
