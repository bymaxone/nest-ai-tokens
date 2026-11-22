/**
 * @fileoverview The sweep of wallet debits no ledger row stands behind. A keyed call whose ledger append failed keeps its
 * debit so that a retry replays it; a call that is never retried leaves the debit and no row. The sweep lists the debits
 * older than the grace and younger than the retention, looks at the ledger row under each key, and for a key with none
 * appends a released claim row that owes the wallet refund, then finishes the refund. The claim and a late append of the
 * call exclude each other on the key, so the debit is given back by exactly one of them. It takes no lock, a second
 * sweeper repeats verdicts that already took effect, and a tick walks a bounded number of pages from an in-memory cursor
 * that wraps. A debit older than the retention is outside what it repairs.
 * @layer server
 */

import { Logger } from '@nestjs/common'
import { describeError } from '../errors/describe-error'
import type { UsageRecord } from '../../shared'
import type { IWalletStore, OwedEffects, WalletDebit, WalletDebitCursor } from '../interfaces'
import { methodOf } from '../utils/field-names'
import { guardedStore } from '../utils/guarded-store'
import type { LedgerAppendInput, LedgerService } from '../services/ledger.service'
import { isIdempotencyConflict } from '../services/record-replay'
import {
  DEBIT_PREFIXES,
  ORPHAN_CLAIM,
  ORPHAN_DEBIT_REASON,
  ledgerKeyOfDebit,
} from '../utils/orphan-claim'

/** The debits read per page. */
const PAGE_SIZE = 100
/** The most pages a tick walks. */
const PAGES_PER_TICK = 5
/** Milliseconds per second. */
const MS_PER_SECOND = 1_000
/** Stable log key for a failed listing (the tick ends; the next one retries). */
const SCAN_FAILED_LOG_KEY = 'ai_tokens.orphan_debit_sweep.scan_failed'
/** Stable log key for the debits a tick could not settle: one line with a count per tick. */
const SETTLE_FAILED_LOG_KEY = 'ai_tokens.orphan_debit_sweep.settle_failed'

/** The times the sweep reads. */
export interface OrphanDebitSweeperOptions {
  /** A debit is judged once it is older than this. */
  graceSeconds: number
  /** A debit older than this is outside the sweep. */
  retentionSeconds: number
}

/** Tuning of the walk, for tests. */
export interface OrphanDebitSweepTuning {
  pageSize?: number
  pages?: number
}

/** The sweep of orphan debits over one wallet store and one ledger. */
export class OrphanDebitSweeper {
  private readonly logger = new Logger(OrphanDebitSweeper.name)
  private cursor: WalletDebitCursor | undefined
  private readonly pageSize: number
  private readonly pages: number

  /**
   * @param wallets The wallet store, whose cross-wallet listing of debits the sweep reads.
   * @param ledger The ledger service: the lookup under a key and the claim append.
   * @param options The grace and the retention.
   * @param now The injected clock.
   * @param finish Runs the refund a claim owes; the owed-effects sweep repeats it when this fails.
   * @param tuning The page size and the pages per tick.
   */
  private readonly wallets: Pick<IWalletStore, 'findDebitsBefore'>

  constructor(
    wallets: Pick<IWalletStore, 'findDebitsBefore'>,
    private readonly ledger: LedgerService,
    private readonly options: OrphanDebitSweeperOptions,
    private readonly now: () => Date,
    private readonly finish: (owed: OwedEffects) => Promise<void>,
    tuning: OrphanDebitSweepTuning = {},
  ) {
    this.wallets = guardedStore(wallets)
    this.pageSize = tuning.pageSize ?? PAGE_SIZE
    this.pages = tuning.pages ?? PAGES_PER_TICK
  }

  /** Whether the sweep can run: the wallet store lists debits across wallets and the ledger keeps the marker. */
  get supported(): boolean {
    return methodOf(this.wallets, 'findDebitsBefore') !== undefined && this.ledger.supportsOwedEffects()
  }

  /** Walk one tick; the cursor wraps on an empty page. */
  async sweep(): Promise<void> {
    const list = methodOf(this.wallets, 'findDebitsBefore') as IWalletStore['findDebitsBefore']
    if (list === undefined || !this.ledger.supportsOwedEffects()) return
    const now = this.now().getTime()
    const olderThan = new Date(now - this.options.graceSeconds * MS_PER_SECOND)
    const newerThan = new Date(now - this.options.retentionSeconds * MS_PER_SECOND)
    let failed = 0
    for (let page = 0; page < this.pages; page++) {
      let found: WalletDebit[]
      try {
        found = await list({
          keyPrefixes: [...DEBIT_PREFIXES],
          olderThan,
          newerThan,
          limit: this.pageSize,
          ...(this.cursor === undefined ? {} : { after: this.cursor }),
        })
      } catch (error) {
        this.logger.warn(
          `${SCAN_FAILED_LOG_KEY} ${describeError(error)}`,
        )
        return
      }
      const last = found[found.length - 1]
      if (last === undefined) {
        this.cursor = undefined
        break
      }
      this.cursor = { createdAt: last.entry.createdAt, id: last.entry.id }
      for (const debit of found) {
        try {
          await this.settle(debit)
        } catch {
          failed += 1
        }
      }
    }
    if (failed > 0) this.logger.warn(`${SETTLE_FAILED_LOG_KEY} count=${String(failed)}`)
  }

  /** Give one debit its verdict: leave it when a row stands under its key, claim it otherwise and finish the refund. */
  private async settle({ ref, entry }: WalletDebit): Promise<void> {
    const key = ledgerKeyOfDebit(entry.idempotencyKey)
    if (key === null) return
    if ((await this.ledger.findByIdempotencyKey(ref.tenantId, key)) !== null) return
    const claim = await this.claim(ref, key, entry)
    if (claim === null) return
    await this.finish({ record: claim, reason: ORPHAN_DEBIT_REASON })
  }

  /** Append the claim row with the marker in the same statement; a conflict means the key was taken meanwhile. */
  private async claim(
    ref: WalletDebit['ref'],
    key: string,
    entry: WalletDebit['entry'],
  ): Promise<UsageRecord | null> {
    const input: LedgerAppendInput = {
      tenantId: ref.tenantId,
      scope: { type: ref.ownerType, id: ref.ownerId },
      provider: ORPHAN_CLAIM,
      model: ORPHAN_CLAIM,
      operation: 'chat',
      serviceTier: 'standard',
      feature: ORPHAN_CLAIM,
      tags: [],
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      reasoningTokens: 0,
      audioInTokens: 0,
      audioOutTokens: 0,
      imageInTokens: 0,
      imageOutTokens: 0,
      priceVersionId: null,
      rawCostNanoUsd: 0n,
      surchargeNanoUsd: 0n,
      billedCostNanoUsd: -entry.amountNanoUsd,
      markupMultiplier: 1,
      currency: 'USD',
      priceMissing: false,
      status: 'released',
      requestId: entry.idempotencyKey,
      isSystemCost: false,
      enforced: true,
      occurredAt: this.now(),
    }
    try {
      return await this.ledger.append(input, key, { reason: ORPHAN_DEBIT_REASON })
    } catch (error) {
      if (isIdempotencyConflict(error)) return null
      throw error
    }
  }
}
