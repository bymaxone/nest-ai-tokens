/**
 * @fileoverview The names a README snippet uses without declaring them, typed
 * against the published package. `check-published-surface.mjs` copies this file into
 * the throwaway consumer it compiles the snippets in, so a call made through one of
 * these names is checked against the real types instead of resolving to `any`.
 * Only names the surrounding prose introduces belong here; a wrong option, method or
 * field on a package type is a real error and must stay one.
 */
import type { ServerResponse } from 'node:http'
import type {
  BudgetService,
  MeteringContext,
  MeteringScope,
  MeteringService,
  UsageReportService,
  WalletService,
} from '@bymax-one/nest-ai-tokens'
import type { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'

/** The Prisma client the store takes, read from the store so it cannot drift. */
type HostPrismaClient = ConstructorParameters<typeof PrismaAiTokensStore>[0]

declare global {
  /** What `this` holds in a snippet that shows service calls without a class around them. */
  interface SnippetContext {
    metering: MeteringService
    wallets: WalletService
    budgets: BudgetService
    reports: UsageReportService
  }

  const metering: MeteringService
  const wallets: WalletService
  const budgets: BudgetService
  const reports: UsageReportService

  const tenantId: string
  const userId: string
  const jobId: string
  const cycle: string
  const ctx: MeteringContext
  const scope: MeteringScope
  const res: ServerResponse
  const now: Date
  const from: Date
  const to: Date
  const thirtyDaysAgo: Date
  const nextRenewal: Date
  const estimatedInput: number
  const messages: never[]
  const plan: { maxAIGenerationsPerMonth: number; aiTokensMonthly: number }
  const subscription: { renewalDate: Date }

  /** The host's Prisma module and service, introduced by the surrounding prose. */
  class PrismaModule {}
  type PrismaService = HostPrismaClient
  const PrismaService: new () => HostPrismaClient

  /** A provider client the host owns; only the call shape the snippets use. */
  const openai: {
    chat: {
      completions: {
        create(args: {
          model: string
          messages: unknown[]
          stream?: boolean
          stream_options?: unknown
        }): Promise<AsyncIterable<{ choices: { delta?: { content?: string | null } }[] }>>
      }
    }
  }
}

export {}
