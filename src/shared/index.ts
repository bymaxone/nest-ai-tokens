/**
 * @fileoverview Public barrel for the zero-dependency `./shared` subpath —
 * canonical types, catalogs, provider usage normalizers, pure cost math, money
 * utilities, and error codes. Framework-free and edge-safe: no NestJS, Prisma,
 * Redis-client, or Node built-in imports.
 * @layer shared
 */

// Catalogs & constants (runtime values + their derived union types).
export * from './constants/provider-ids.constants'
export * from './constants/operations.constants'
export * from './constants/service-tiers.constants'
export * from './constants/token-categories.constants'
export * from './constants/wallet-entry-types.constants'
export * from './constants/error-codes.constants'

// Pure money math and utilities.
export * from './pricing/money'
export * from './utils/idempotency'

// Canonical types.
export * from './types/catalogs'
export * from './types/normalized-usage'
export * from './types/price-version'
export * from './types/usage-record'
export * from './types/wallet'
export * from './types/budget'
export * from './types/report'
export * from './types/events'
export * from './types/error-types'
