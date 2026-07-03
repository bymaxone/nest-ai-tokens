/**
 * @fileoverview Type-check-only compilation fixture for the TypeScript code
 * blocks in README.md. Mirrors every snippet that imports from the library so
 * that a breaking type change in the public API surfaces here immediately.
 *
 * Run:  pnpm docs:check   (tsc -p tsconfig.e2e.json includes test/**\/*)
 *
 * This file is never executed; it only needs to compile cleanly.
 */

import type { ExecutionContext } from '@nestjs/common'
import {
  BymaxAiTokensModule,
  MeteringService,
  BudgetGuard,
  MeteringInterceptor,
  Meter,
  RequireBudget,
  StreamUsageCollector,
  providerPresets,
  toJsonSafe,
} from '@bymax-one/nest-ai-tokens'
import type {
  BymaxAiTokensModuleOptions,
  IAiTokensStore,
  IMarkupPolicy,
  MeteringContext,
} from '@bymax-one/nest-ai-tokens'
import { PrismaAiTokensStore } from '@bymax-one/nest-ai-tokens/prisma'
import { deriveIdempotencyKey, formatNanoUsd } from '@bymax-one/nest-ai-tokens/shared'
import type { NormalizedUsage } from '@bymax-one/nest-ai-tokens/shared'

// ————————————————————————————————————————————————————————————————
// §2 Quick Start: module options shape
// ————————————————————————————————————————————————————————————————

const _moduleOptions: BymaxAiTokensModuleOptions = {
  store: {} as IAiTokensStore,
  markup: 4.0,
  wallets: { creditRateNanoUsd: 5_000_000_000n },
  budgets: { defaultPolicy: 'block', alertThresholds: [0.8, 1.0] },
  pricing: { seedFromSnapshot: true },
}
void _moduleOptions

// forRootAsync compiles — useFactory cast needed because NestJS types inject as unknown[]:
declare const prismaInstance: never
BymaxAiTokensModule.forRootAsync({
  useFactory: () => ({
    store: new PrismaAiTokensStore(prismaInstance),
    markup: 4.0,
    wallets: { creditRateNanoUsd: 5_000_000_000n },
    budgets: { defaultPolicy: 'block' as const, alertThresholds: [0.8, 1.0] },
    pricing: { seedFromSnapshot: true },
  }),
})

// ————————————————————————————————————————————————————————————————
// §3 Quick Start: record usage
// ————————————————————————————————————————————————————————————————

declare const meteringService: MeteringService
declare const jobId: string
declare const tenantId: string
declare const userId: string

const _key: string = deriveIdempotencyKey({ jobId })
void _key

async function _exampleRecord(): Promise<void> {
  await meteringService.record({
    usage: {} as NormalizedUsage,
    preset: providerPresets.openaiChat,
    context: {
      tenantId,
      scope: { type: 'user', id: userId },
      feature: 'workout.generate',
      idempotencyKey: deriveIdempotencyKey({ jobId }),
    },
  })
}
void _exampleRecord

// ————————————————————————————————————————————————————————————————
// §4 Quick Start: guard + interceptor decorators compile
// ————————————————————————————————————————————————————————————————

void BudgetGuard
void MeteringInterceptor
void Meter
void RequireBudget

// ————————————————————————————————————————————————————————————————
// §5 Markup / IMarkupPolicy
// IMarkupPolicy.resolve receives a markup-context subset (not full MeteringContext).
// ————————————————————————————————————————————————————————————————

type _MarkupCtx = Parameters<IMarkupPolicy['resolve']>[0]

class _MyMarkupPolicy implements IMarkupPolicy {
  resolve(ctx: _MarkupCtx): number | Promise<number> {
    return ctx.feature === 'premium.summarize' ? 5.0 : 3.0
  }
}
void _MyMarkupPolicy

// ————————————————————————————————————————————————————————————————
// §6 Streaming — StreamUsageCollector
// ————————————————————————————————————————————————————————————————

const _collector = new StreamUsageCollector({
  provider: 'openai',
  model: 'gpt-4o',
  preset: providerPresets.openaiChat,
})
void _collector.push({})
const _finalUsage: Promise<NormalizedUsage> = _collector.finalize()
void _finalUsage

// ————————————————————————————————————————————————————————————————
// §7 Reporting — toJsonSafe + formatNanoUsd
// ————————————————————————————————————————————————————————————————

const _safe = toJsonSafe({ balanceNanoUsd: 5_000_000_000n, tokens: 1000 })
void _safe

const _displayUsd: string = formatNanoUsd(5_000_000n)
const _displayBrl: string = formatNanoUsd(5_000_000n, {
  currency: 'BRL',
  fxRateNano: 5_000_000_000n,
})
void _displayUsd
void _displayBrl

// ————————————————————————————————————————————————————————————————
// §8 scopeResolver shape — MeteringContext
// ————————————————————————————————————————————————————————————————

const _scopeResolver = (_ctx: ExecutionContext): MeteringContext => ({
  tenantId: 'tenant-1',
  scope: { type: 'user', id: 'user-1' },
  feature: 'doc.summarize',
})
void _scopeResolver
