/**
 * `ssbazar/no-hardcoded-strings` — CLAUDE.md invariant 19, as a build failure.
 *
 * > All UI strings come from `en.json` / `hi.json`. No hardcoded user-facing
 * > text, ever.
 *
 * This exists before the first screen rather than after it, and that ordering
 * is the whole point (`docs/DECISIONS.md` D34). Retrofitting is not a
 * mechanical job: it is where you find out that a string was assembled from
 * fragments, or interpolated mid-sentence in a way Hindi word order will not
 * take. Catching the first one costs a minute. Catching the four hundredth
 * costs a week, and by then nobody reads the report.
 *
 * ## What it flags, and why it is not "every string literal"
 *
 * A rule that flagged every literal would flag SQL, column names, barcode
 * types, error codes and CSS classes, and would be switched off inside a week —
 * which is strictly worse than no rule, because a disabled rule still looks
 * like coverage. So this one asks a narrower question with a reliable answer:
 *
 *   **does this text reach a person?**
 *
 * Text reaches a person through a small, enumerable set of exits:
 *
 *   - an argument to `console.*` or a `process.std*.write` — the CLIs
 *   - text inside JSX, and JSX attributes that render as words (`title`,
 *     `placeholder`, `aria-label`…) — the screens, from step 7 onward
 *
 * Everything else is internal until it reaches one of those, and at that point
 * it is a variable rather than a literal. The `USAGE` constant that step 5's
 * CLI printed *was* caught, because the rule resolves a plain identifier back
 * to its initialiser — one hop, using ESLint's own scope analysis. That single
 * hop is the difference between a rule that works on real code and one that is
 * defeated by `const MESSAGE = '...'`.
 *
 * ## What is allowed at a sink
 *
 *   - `t(...)`, `translate(...)`, `output.say(...)` — anything on `translators`
 *   - a string with no letters in it at all: `''`, `'  '`, `'---'`, `'\n'`,
 *     `': '`. Padding and separators are layout, not language.
 *   - a template literal whose fixed parts are all letterless — so
 *     `` `${a}: ${b}` `` passes and `` `applied ${file}` `` does not
 *
 * ## Getting out of it
 *
 * ESLint's own directive, with a reason:
 *
 *     // eslint-disable-next-line ssbazar/no-hardcoded-strings -- brand name
 *
 * Deliberately no bespoke escape hatch. A second mechanism would be one the
 * reviewer has to learn, and `--report-unused-disable-directives` already
 * cleans up after this one.
 *
 * The rule is not the whole of invariant 19 and is not meant to be. It stops a
 * string that was never externalised; `TranslationKey` in `@ssbazar/shared`
 * stops a key that does not resolve. Neither can do the other's half.
 */

const DEFAULT_SINKS = [
  'console.log',
  'console.error',
  'console.warn',
  'console.info',
  'console.debug',
  'console.trace',
  'process.stdout.write',
  'process.stderr.write',
  // The project's own pass-through printers, matched on their last segment, so
  // `output.line` and `out.plain` are both caught. Anything that takes a
  // rendered string and shows it is a sink; `say`, `warn` and `report` take a
  // key or a { key, params } and are checked by the type system instead.
  'line',
  'plain',
];

const DEFAULT_TRANSLATORS = ['t', 'translate'];

/**
 * Attributes that render as words a person reads. Not an exhaustive list of
 * every string attribute — `className`, `id`, `type` and `href` are not text.
 */
const DEFAULT_JSX_ATTRIBUTES = [
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'caption',
  'confirmLabel',
  'emptyMessage',
  'heading',
  'help',
  'hint',
  'label',
  'placeholder',
  'subtitle',
  'title',
  'tooltip',
];

/** Any Unicode letter. A string without one is punctuation, digits or space. */
const HAS_LETTER = /\p{L}/u;

/** @param {string} value */
function isProse(value) {
  return HAS_LETTER.test(value);
}

/**
 * The dotted name of a callee, as written: `console.log`, `output.say`, `t`.
 * Returns null for anything computed — `console[method]()` is not a name.
 *
 * @param {import('estree').Node} node
 * @returns {string | null}
 */
function calleeName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed) {
    const object = calleeName(node.object);
    const property = calleeName(node.property);
    return object === null || property === null ? null : `${object}.${property}`;
  }
  return null;
}

/** The last segment: `output.say` → `say`. Lets `t` match `strings.t`. */
function lastSegment(name) {
  const index = name.lastIndexOf('.');
  return index === -1 ? name : name.slice(index + 1);
}

/**
 * Resolves an identifier to the expression it was initialised with, one hop.
 *
 * Only for a `const` with a single definition and no reassignment, which is
 * what a module-level `const USAGE = '...'` is. Anything looser is a guess, and
 * a lint rule that guesses gets disabled.
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Node} node
 */
function resolveConstant(sourceCode, node) {
  if (node.type !== 'Identifier') return null;

  const scope = sourceCode.getScope(node);
  let variable = null;
  for (let current = scope; current !== null && variable === null; current = current.upper) {
    variable = current.variables.find((candidate) => candidate.name === node.name) ?? null;
  }
  if (variable === null || variable.defs.length !== 1) return null;

  const [definition] = variable.defs;
  if (definition.type !== 'Variable' || definition.parent.kind !== 'const') return null;

  const { init } = definition.node;
  return init ?? null;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require user-facing text to come from en.json / hi.json rather than being written inline.',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          sinks: { type: 'array', items: { type: 'string' } },
          translators: { type: 'array', items: { type: 'string' } },
          jsxAttributes: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      hardcoded:
        'Hardcoded user-facing text: {{text}}. Add a key to en.json / hi.json and call the ' +
        'translator (CLAUDE.md invariant 19).',
      hardcodedVia:
        'Hardcoded user-facing text reaches {{sink}} through "{{name}}": {{text}}. Add a key to ' +
        'en.json / hi.json and call the translator (CLAUDE.md invariant 19).',
      hardcodedJsx:
        'Hardcoded user-facing text in JSX: {{text}}. Add a key to en.json / hi.json and call ' +
        'the translator (CLAUDE.md invariant 19).',
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const sinks = new Set(options.sinks ?? DEFAULT_SINKS);
    const translators = new Set(options.translators ?? DEFAULT_TRANSLATORS);
    const jsxAttributes = new Set(options.jsxAttributes ?? DEFAULT_JSX_ATTRIBUTES);
    const { sourceCode } = context;

    /** Trimmed and shortened, so the report fits on a terminal line. */
    const quote = (value) => {
      const collapsed = value.replace(/\s+/gu, ' ').trim();
      return collapsed.length > 40 ? `"${collapsed.slice(0, 39)}…"` : `"${collapsed}"`;
    };

    const matches = (set, name) => set.has(name) || set.has(lastSegment(name));

    const isTranslatorCall = (node) => {
      if (node.type !== 'CallExpression') return false;
      const name = calleeName(node.callee);
      return name !== null && matches(translators, name);
    };

    /**
     * Reports `node` if it is prose. `origin` is the identifier it was reached
     * through, when the literal is not at the sink itself.
     */
    const checkExpression = (node, sink, origin) => {
      if (node.type === 'Literal') {
        if (typeof node.value !== 'string' || !isProse(node.value)) return;
      } else if (node.type === 'TemplateLiteral') {
        // Only the fixed parts. The holes are values, and a value is not text
        // this rule can do anything about.
        if (!node.quasis.some((quasi) => isProse(quasi.value.cooked ?? quasi.value.raw))) return;
      } else {
        return;
      }

      const text = quote(sourceCode.getText(node));
      if (origin === undefined) {
        context.report({ node, messageId: 'hardcoded', data: { text } });
      } else {
        context.report({
          node: origin,
          messageId: 'hardcodedVia',
          data: { text, sink, name: origin.name },
        });
      }
    };

    const checkArgument = (argument, sink) => {
      if (argument.type === 'SpreadElement') return;
      if (isTranslatorCall(argument)) return;

      // A conditional at a sink is two candidates, not one:
      //   console.log(quiet ? 'nothing to do' : t('cli.done'))
      if (argument.type === 'ConditionalExpression') {
        checkArgument(argument.consequent, sink);
        checkArgument(argument.alternate, sink);
        return;
      }

      // Concatenation, the other way a sentence gets assembled.
      if (argument.type === 'BinaryExpression' && argument.operator === '+') {
        checkArgument(argument.left, sink);
        checkArgument(argument.right, sink);
        return;
      }

      if (argument.type === 'Identifier') {
        const initialiser = resolveConstant(sourceCode, argument);
        if (initialiser !== null) checkExpression(initialiser, sink, argument);
        return;
      }

      checkExpression(argument, sink);
    };

    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === null || !matches(sinks, name)) return;
        for (const argument of node.arguments) checkArgument(argument, name);
      },

      JSXText(node) {
        if (!isProse(node.value)) return;
        context.report({ node, messageId: 'hardcodedJsx', data: { text: quote(node.value) } });
      },

      JSXAttribute(node) {
        const name = node.name.type === 'JSXIdentifier' ? node.name.name : null;
        if (name === null || !jsxAttributes.has(name)) return;

        const { value } = node;
        if (value === null) return;

        if (value.type === 'Literal') {
          if (typeof value.value !== 'string' || !isProse(value.value)) return;
          context.report({
            node: value,
            messageId: 'hardcodedJsx',
            data: { text: quote(value.value) },
          });
          return;
        }

        if (value.type === 'JSXExpressionContainer') {
          const inner = value.expression;
          if (inner.type === 'JSXEmptyExpression' || isTranslatorCall(inner)) return;
          if (inner.type !== 'Literal' && inner.type !== 'TemplateLiteral') return;

          const prose =
            inner.type === 'Literal'
              ? typeof inner.value === 'string' && isProse(inner.value)
              : inner.quasis.some((quasi) => isProse(quasi.value.cooked ?? quasi.value.raw));
          if (!prose) return;

          context.report({
            node: inner,
            messageId: 'hardcodedJsx',
            data: { text: quote(sourceCode.getText(inner)) },
          });
        }
      },
    };
  },
};

export default rule;
