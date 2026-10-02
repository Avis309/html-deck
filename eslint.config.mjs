// Lint for HtmlDeck's ES modules: catches names that a module split leaves undefined or unused
// (node --check only parses). Run by `npm run lint` (part of `npm run check`).
import globals from 'globals';

export default [
  {
    files: ['htmldeck/web/js/**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.browser },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { vars: 'all', args: 'none', caughtErrors: 'none' }],
    },
  },
];
