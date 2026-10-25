import type { Config } from 'jest'
import { pathsToModuleNameMapper } from 'ts-jest'
// @ts-ignore
import tsconfig from './tsconfig.json' with { type: 'json' }

const { compilerOptions } = tsconfig

const config: Config = {
  // Transpile only: type errors are caught by `npm run typecheck`
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: false }]
  },
  testRegex: '(\\.|/)(test|spec)\\.(js|ts)x?$',
  testEnvironment: 'node',
  testTimeout: 10000,
  roots: ['<rootDir>/test'],
  modulePaths: [compilerOptions.baseUrl],
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, { prefix: '<rootDir>/' }),
  setupFilesAfterEnv: ['jest-extended/all'],
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: './coverage',
  coverageReporters: ['text', 'text-summary']
}

export default config
