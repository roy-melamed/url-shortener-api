// ESLint flat config — URL-18 foundation bootstrap.
// Includes the portability-seam rule (FR-9.3 / NFR-7 / design §3.9): domain
// modules (src/{auth,links,analytics,qr,geo}) must not import the Lambda/API
// Gateway adapter or any cloud provider SDK directly. Only the platform/
// entrypoint layer may touch cloud adapters; domain code stays portable so the
// same modules run locally and on Lambda without cloud emulation.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const PORTABILITY_SEAM_MESSAGE =
  'Portability seam (FR-9.3, design §3.9): domain modules must not import ' +
  'Lambda/API Gateway adapters or cloud provider SDKs directly. Cloud ' +
  'adapters belong in the entrypoint/platform layer; inject interfaces instead.';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'cdk.out/**',
      'node_modules/**',
      '.opencode/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Portability seam: domain modules import nothing from Lambda/API Gateway
    // or cloud provider SDKs (FR-9.3; lint-gate AC of URL-18).
    files: ['src/{auth,links,analytics,qr,geo}/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'aws-lambda-fastify',
                'aws-lambda',
                '@aws-lambda/*',
                '@aws-sdk/*',
                'aws-sdk',
                'aws-sdk/*',
              ],
              message: PORTABILITY_SEAM_MESSAGE,
            },
          ],
        },
      ],
    },
  },
);
