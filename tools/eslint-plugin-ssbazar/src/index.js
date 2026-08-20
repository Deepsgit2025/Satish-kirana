/**
 * The project's own ESLint rules.
 *
 * A local plugin rather than a dependency: the rules encode invariants from
 * CLAUDE.md, which are specific to this shop's system and are not something a
 * published package can know. It is also one fewer thing that can need a
 * security update in eight years of unattended running.
 *
 * Wired up in `eslint.config.js` by relative import, so nothing has to be
 * published or linked and `npm install` never sees it.
 */

import noHardcodedStrings from './rules/no-hardcoded-strings.js';

const plugin = {
  meta: {
    name: 'eslint-plugin-ssbazar',
    version: '1.0.0',
  },
  rules: {
    'no-hardcoded-strings': noHardcodedStrings,
  },
};

export default plugin;
