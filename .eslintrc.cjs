module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-restricted-syntax': [
      'error',
      {
        selector: "TSAsExpression[typeAnnotation.typeName.name='any']",
        message: 'Avoid `as any`. Use proper types or `unknown` with narrowing.',
      },
    ],
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.cjs', '*.mjs', '*.tsbuildinfo'],
};
