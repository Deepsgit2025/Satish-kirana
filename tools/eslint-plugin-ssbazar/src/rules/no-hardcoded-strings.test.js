import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { describe, it } from 'vitest';

import rule from './no-hardcoded-strings.js';

/**
 * The rule is a build gate on CLAUDE.md invariant 19, so its own behaviour is
 * worth pinning down. The two halves that matter are symmetrical and neither is
 * obvious:
 *
 *   what it catches - the CLI output that existed before step 6, in the shapes
 *   it actually took: a template literal at a `console.log`, and a `const USAGE`
 *   printed one hop away
 *
 *   what it lets through - SQL, error codes, column names, padding. A rule that
 *   cried wolf on those would be switched off within a week, and a switched-off
 *   rule still looks like coverage on the CI page.
 */

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2023,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe('ssbazar/no-hardcoded-strings', () => {
  it('flags text that reaches a person and nothing else', () => {
    ruleTester.run('no-hardcoded-strings', rule, {
      valid: [
        // The shape every call site should have after step 6.
        { code: `console.log(t('cli.migrate.done', { count: 3 }));` },
        { code: `output.line(t('cli.reconcile.clean'));` },
        { code: `output.say('cli.catalogue.dry_run_note');` },

        // Padding, separators and blank lines are layout, not language.
        { code: `console.log('');` },
        { code: `console.log('  ');` },
        { code: `console.log('---');` },
        { code: `output.plain('');` },

        // A template whose fixed parts carry no letters is composition, and the
        // holes are values this rule can say nothing about.
        { code: 'console.log(`${a}: ${b}`);' },
        { code: 'output.line(`${pad(key, 20)}  ${status}`);' },

        // Not a sink. SQL, keys, column names and codes are internal strings
        // and stay internal strings.
        { code: `const SQL = 'SELECT id, name FROM products WHERE is_active';` },
        { code: `throw new TaxInputError('bill.no_lines');` },
        { code: `checker.fail('hsn_code', 'catalogue.issue.hsn_not_six_digits');` },
        { code: `const barcodeType = /^\\d{13}$/.test(code) ? 'ean13' : 'manual';` },
        { code: `element.setAttribute('data-testid', 'total row');` },

        // A flag is typed back by the operator character for character, so it
        // must not be translated - and it is data here, not an argument to a
        // sink.
        { code: `const USAGE = { options: [{ flag: '--dry-run', description: 'cli.x' }] };` },

        // JSX that already goes through the translator.
        { code: `const view = <p>{t('product.empty')}</p>;` },
        { code: `const view = <input placeholder={t('product.search')} />;` },
        { code: `const view = <div className="totals-row" id="totals" />;` },

        // The escape hatch - `// eslint-disable-next-line
        // ssbazar/no-hardcoded-strings -- reason` - is deliberately not
        // exercised here. RuleTester registers the rule under a name of its
        // own, so a directive naming the real one reports as an unknown rule
        // and the case would be testing RuleTester rather than this rule. It is
        // covered end to end by `npm run lint` over the repository.
      ],

      invalid: [
        // Exactly what server/src/reconciliation/run.ts looked like at step 5.
        {
          code: 'console.log(`[reconcile] ${message}`);',
          errors: [{ messageId: 'hardcoded' }],
        },
        {
          code: `console.error('the file could not be read');`,
          errors: [{ messageId: 'hardcoded' }],
        },

        // The one-hop resolution: this is how all three CLIs printed --help,
        // and a rule that only looked at the literal in the call would have
        // passed every one of them.
        {
          code: `const USAGE = 'Usage: npm run db:migrate';\nconsole.log(USAGE);`,
          errors: [{ messageId: 'hardcodedVia' }],
        },

        // A sentence assembled from pieces - which is the failure mode D34
        // warns about, because Hindi will not take the same word order.
        {
          code: `console.log('applied ' + filename);`,
          errors: [{ messageId: 'hardcoded' }],
        },
        {
          code: 'output.line(`applied ${filename} (${ms} ms)`);',
          errors: [{ messageId: 'hardcoded' }],
        },

        // A conditional at a sink is two candidates, not one, and the English
        // half is easy to miss when the other half is already translated.
        {
          code: `console.log(quiet ? 'nothing to do' : t('cli.done'));`,
          errors: [{ messageId: 'hardcoded' }],
        },

        // The screens, from step 7 onward.
        {
          code: `const view = <p>No products found</p>;`,
          errors: [{ messageId: 'hardcodedJsx' }],
        },
        {
          code: `const view = <input placeholder="Search products" />;`,
          errors: [{ messageId: 'hardcodedJsx' }],
        },
        {
          code: `const view = <button aria-label={'Void this bill'} />;`,
          errors: [{ messageId: 'hardcodedJsx' }],
        },
      ],
    });
  });
});
