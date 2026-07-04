/**
 * @fileoverview AdminController — privileged admin-plane operations (spec §14.4).
 *
 * The admin plane covers operations that create or modify financial records:
 * - Grant wallet credits (spec §21.5)
 * - Upsert budgets tied to subscription plans (spec §21.5)
 * - Reverse a posted usage record (compensating entry, never DELETE)
 * - Export usage as CSV
 *
 * SECURITY: Restrict to admin roles in production (e.g. RBAC guard, not just x-role header).
 *
 * @layer presentation
 */
import { Body, Controller, Get, ForbiddenException, Post, Query, Res, UnauthorizedException } from '@nestjs/common'
import type { Response } from 'express'
import { WalletService, BudgetService, LedgerService, UsageReportService, toJsonSafe } from '@bymax-one/nest-ai-tokens'
import { CurrentUser, AuthedUser } from '../auth/auth.decorator.js'

/** DTO for granting wallet credits to a user. */
interface GrantCreditsDto {
  readonly userId: string
  readonly tenantId: string
  /** Amount in nano-USD (bigint as string — spec §15.5). */
  readonly amountNanoUsd: string
  readonly reason: string
  readonly idempotencyKey: string
}

/** DTO for upserting a plan budget. */
interface UpsertBudgetDto {
  readonly userId: string
  readonly tenantId: string
  readonly features: string[]
  readonly window: 'day' | 'week' | 'month' | 'total'
  readonly limitTokens?: string
  readonly limitCount?: string
  readonly anchorAt?: string
}

/** DTO for reversing a posted record (compensating entry). */
interface ReverseRecordDto {
  readonly recordId: string
  readonly reason: string
  readonly idempotencyKey: string
}

/**
 * Admin-plane HTTP controller for privileged billing operations.
 * All routes require the `x-role: admin` header (example stub; use real RBAC in production).
 */
@Controller('admin')
export class AdminController {
  constructor(
    private readonly wallets: WalletService,
    private readonly budgets: BudgetService,
    private readonly ledger: LedgerService,
    private readonly reports: UsageReportService,
  ) {}

  private assertAdmin(user: AuthedUser): void {
    if (user.role !== 'admin') {
      throw new ForbiddenException('Admin role required')
    }
  }

  /**
   * Grant wallet credits to a user (spec §21.5).
   *
   * ```bash
   * curl -X POST http://localhost:3000/admin/grant \
   *   -H "Content-Type: application/json" \
   *   -H "x-role: admin" \
   *   -d '{"userId":"user-demo","tenantId":"tenant-demo","amountNanoUsd":"25000000000","reason":"monthly allowance","idempotencyKey":"grant:user-demo:2026-07"}'
   * ```
   */
  @Post('grant')
  async grantCredits(
    @Body() dto: GrantCreditsDto,
    @CurrentUser() user: AuthedUser,
  ): Promise<unknown> {
    this.assertAdmin(user)
    const entry = await this.wallets.grant(
      { tenantId: dto.tenantId, ownerType: 'user', ownerId: dto.userId },
      {
        amountNanoUsd: BigInt(dto.amountNanoUsd),
        reason: dto.reason,
        idempotencyKey: dto.idempotencyKey,
      },
    )
    return toJsonSafe(entry)
  }

  /**
   * Upsert a plan budget for a user (spec §21.5).
   *
   * Typically called on subscription creation or renewal. The `anchorAt` date
   * makes the budget window follow the subscription renewal cycle, not the
   * calendar month — eliminating the "tokens reset on the wrong day" bug.
   *
   * ```bash
   * curl -X POST http://localhost:3000/admin/budget \
   *   -H "Content-Type: application/json" \
   *   -H "x-role: admin" \
   *   -d '{"userId":"user-demo","tenantId":"tenant-demo","features":["chat.reply","doc.summarize"],"window":"month","limitTokens":"500000","anchorAt":"2026-08-01T00:00:00Z"}'
   * ```
   */
  @Post('budget')
  async upsertBudget(
    @Body() dto: UpsertBudgetDto,
    @CurrentUser() user: AuthedUser,
  ): Promise<unknown> {
    this.assertAdmin(user)
    const budget = await this.budgets.upsertBudget({
      tenantId: dto.tenantId,
      scope: { type: 'user', id: dto.userId },
      features: dto.features,
      window: dto.window,
      limitTokens: dto.limitTokens !== undefined ? BigInt(dto.limitTokens) : undefined,
      limitCount: dto.limitCount !== undefined ? BigInt(dto.limitCount) : undefined,
      softThresholds: [0.8, 1.0],
      policy: 'block',
      anchorAt: dto.anchorAt !== undefined ? new Date(dto.anchorAt) : undefined,
    })
    return toJsonSafe(budget)
  }

  /**
   * Reverse a posted usage record (compensating entry — never a DELETE).
   *
   * The ledger is append-only: reversals create a new REVERSED record with a
   * negative amount that cancels the original. The original record is never modified.
   *
   * ```bash
   * curl -X POST http://localhost:3000/admin/reverse \
   *   -H "Content-Type: application/json" \
   *   -H "x-role: admin" \
   *   -d '{"recordId":"<uuid>","reason":"double-billed","idempotencyKey":"rev:<uuid>"}'
   * ```
   */
  @Post('reverse')
  async reverseRecord(
    @Body() dto: ReverseRecordDto,
    @CurrentUser() user: AuthedUser,
  ): Promise<unknown> {
    if (user.role !== 'admin') throw new UnauthorizedException()
    const reversed = await this.ledger.reverse(dto.recordId, {
      reason: dto.reason,
      idempotencyKey: dto.idempotencyKey,
    })
    return toJsonSafe(reversed)
  }

  /**
   * Export usage as CSV for a tenant over a date range.
   *
   * ```bash
   * curl "http://localhost:3000/admin/export?tenantId=tenant-demo&from=2026-07-01&to=2026-07-31" \
   *   -H "x-role: admin" \
   *   -o usage.csv
   * ```
   */
  @Get('export')
  async exportCsv(
    @Query('tenantId') tenantId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @CurrentUser() user: AuthedUser,
    @Res() res: Response,
  ): Promise<void> {
    this.assertAdmin(user)
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const toDate = to ? new Date(to) : new Date()

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="usage-${tenantId}-${fromDate.toISOString().slice(0, 10)}.csv"`)

    const stream = this.reports.export({ tenantId, from: fromDate, to: toDate, format: 'csv' })
    for await (const chunk of stream) {
      res.write(chunk)
    }
    res.end()
  }
}
