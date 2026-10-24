import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/release/**',
      '**/out/**',
      '**/_site/**',
      '**/.astro/**',
      '**/*.d.ts',
      '**/coverage/**',
      '**/resources/extensions/**',
      '**/resources/**',
      // Agent worktrees are whole clones of the repo. Linting them reports
      // every finding twice and pins them to paths that are not the checkout.
      '.claude/worktrees/**',
    ],
  },
  {
    // Repo tooling runs under Node, not in a renderer, so it gets Node globals.
    files: ['**/scripts/**/*.{js,mjs,cjs}', 'tools/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
