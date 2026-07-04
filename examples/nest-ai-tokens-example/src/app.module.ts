/**
 * @fileoverview AppModule — root application module wiring BymaxAiTokensModule (spec §21.5).
 *
 * Demonstrates:
 * - `BymaxAiTokensModule.forRootAsync()` with PrismaAiTokensStore
 * - markup: 4.0 (end-users pay 4× provider cost)
 * - wallets with $5 credit rate
 * - budgets with 80% alert threshold and hard block policy
 * - Optional Redis counter for sub-ms cross-replica budget enforcement
 *
 * @layer module
 */
import { Module } from '@nestjs/common'
import { BymaxAiTokensModule } from '@bymax-one/nest-ai-tokens'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'
import { RedisBudgetCounterStore } from '@bymax-one/nest-ai-tokens/redis'
import { Redis } from 'ioredis'
import { PrismaService } from './prisma/prisma.service.js'
import { AiModule } from './ai/ai.module.js'
import { AdminModule } from './admin/admin.module.js'

/**
 * Root application module.
 *
 * The `BymaxAiTokensModule` is global — all its exported services
 * (MeteringService, WalletService, BudgetService, LedgerService, UsageReportService)
 * are available to every feature module without re-importing.
 */
@Module({
  imports: [
    BymaxAiTokensModule.forRootAsync({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        // Storage adapter: seven-table SQL schema (spec §15)
        store: new PrismaAiTokensStore(prisma),

        // Markup: end-users billed at 4× provider cost (spec §21.5)
        markup: 4.0,

        // Wallets: 1 credit = $5 USD (5_000_000_000 nano-USD)
        wallets: {
          creditRateNanoUsd: 5_000_000_000n,
          burnOrder: 'expiry',
        },

        // Budgets: block at 100% with soft alert at 80%
        budgets: {
          defaultPolicy: 'block',
          alertThresholds: [0.8, 1.0],
        },

        // Pricing: seed from the bundled snapshot on first boot
        pricing: {
          seedFromSnapshot: true,
          cacheTtlMs: 5 * 60 * 1000,
        },

        // Optional Redis counter for cross-replica budget enforcement
        budgetCounter: process.env['REDIS_URL']
          ? new RedisBudgetCounterStore(new Redis(process.env['REDIS_URL']))
          : undefined,

        // Scope resolver: extract tenant + scope from the request context
        // In a real app this comes from a verified JWT claim
        scopeResolver: (executionContext) => {
          const req = executionContext.switchToHttp().getRequest<{
            headers: Record<string, string>
          }>()
          const tenantId = req.headers['x-tenant-id'] ?? 'tenant-demo'
          const userId = req.headers['x-user-id'] ?? 'user-demo'
          return {
            tenantId,
            scope: { type: 'user', id: userId },
            feature: 'default',
          }
        },
      }),
      extraProviders: [PrismaService],
    }),
    AiModule,
    AdminModule,
  ],
})
export class AppModule {}
