import globals from 'globals'
import js from '@eslint/js'

export default [
  {
    ignores: ['**/package-lock.json', 'node_modules/**', '.release/**', 'html/dist/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': 'warn',
    },
  },
  {
    files: ['web/src/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        // loaded as a script tag from the CDN bundle in html/index.html
        bootstrap: 'readonly',
      },
    },
  },
]
