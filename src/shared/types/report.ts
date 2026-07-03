/**
 * @fileoverview Reporting types: the query filter and the aggregated usage
 * summary (including the cache-savings figure) produced by `UsageReportService`.
 * @layer shared
 */

import type { AiOperation } from '../constants/operations.constants'
import type { ServiceTier } from '../constants/service-tiers.constants'
import type { TokenCategory } from '../constants/token-categories.constants'
import type { MeteringScope, ProviderId } from './catalogs'
import type { UsageStatus } from './usage-record'

/** Filter for a usage report query. */
export interface ReportFilter {
  tenantId: string
  scope?: MeteringScope
  beneficiary?: MeteringScope
  feature?: string
  features?: string[]
  provider?: ProviderId
  model?: string
  operation?: AiOperation
  serviceTier?: ServiceTier
  /** Records carrying ANY of these tags. */
  tags?: string[]
  isSystemCost?: boolean
  systemCostCategory?: string
  enforcedOnly?: boolean
  /** Default `['posted', 'reversed']`. */
  status?: UsageStatus[]
  from: Date
  to: Date
}

/** One aggregated row of a usage report. */
export interface UsageSummary {
  /** groupBy key → value; empty groupBy = one grand-total row. */
  group: Record<string, string>
  records: number
  totalTokens: number
  tokens: Record<TokenCategory, number>
  rawCostNanoUsd: bigint
  surchargeNanoUsd: bigint
  billedCostNanoUsd: bigint
  /** Σ cacheReadTokens × (inputRate − cacheReadRate) — the "you saved $X via caching" figure. */
  cacheSavingsNanoUsd: bigint
}
