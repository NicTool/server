import globals from 'globals'
import js from '@eslint/js'

export default [
  {
    ignores: ['**/package-lock.json', 'node_modules/**', '.release/**'],
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
]
