/**
 * @fileoverview No error response carries text a third party wrote. `details` is serialised verbatim into the HTTP body of an
 * `AiTokensException`, and the message of a driver, a store, a policy or an options factory can name a host, a port, a
 * credential or a stored value. Each case makes one of them throw a poisoned message and asserts the serialised response
 * does not contain it while the original error stays on `cause`. Every error code is either produced by a case or listed with
 * the reason it cannot carry such text, so a new code has to be decided here.
 * @layer server
 */

import { Test } from '@nestjs/testing'
import { AI_TOKENS_ERROR_CODES, type AiTokensErrorCode } from './shared'
import { storeError } from './prisma/adapter-sql'
import { BymaxAiTokensModule } from './server/bymax-ai-tokens.module'
import { AiTokensException } from './server/errors'
import { MarkupResolver } from './server/services/markup.resolver'
import { WalletService } from './server/services/wallet.service'
import { InMemoryWalletStore } from '../test/fakes/in-memory-wallet-store'
import { budgetInput, context, makeService } from '../test/fakes/budget-fixtures'

/** A message of the kind a driver or a host writes: a private address, a credential, a stored value. */
const POISON = 'connect ECONNREFUSED 10.0.0.5:5432 password=s3cr3t-token {"email":"a@b.c"}'

/** The exception `run` throws or rejects with, failing when it neither threw nor rejected. */
async function thrownBy(run: () => unknown): Promise<AiTokensException> {
  try {
    await run()
  } catch (error) {
    if (error instanceof AiTokensException) return error
    throw error
  }
  throw new Error('expected the call to throw')
}

/** A Prisma request error as the driver raises it, with a message and a code of the caller's choosing. */
function driverError(message: string, code: string): Error {
  return Object.assign(new Error(message), { name: 'PrismaClientKnownRequestError', code })
}

/** A budget service whose store fails with the poisoned message once a counter makes the database consume authoritative. */
async function poisonedBudget(): Promise<AiTokensException> {
  const counter = { incrIfBelow: () => Promise.resolve(true), decr: () => Promise.resolve(), reset: () => Promise.resolve() }
  const { service, store } = makeService({ options: { counter } })
  await service.upsertBudget(budgetInput({ limitNanoUsd: 100n }))
  jest.spyOn(store, 'conditionalConsume').mockRejectedValue(new Error(POISON))
  return thrownBy(() => service.consume(context(), { nanoUsd: 10n, tokens: 0, count: 0 }))
}

/** A wallet service whose store fails with the poisoned message on a conditional debit. */
function poisonedWallet(): Promise<AiTokensException> {
  const store = new InMemoryWalletStore()
  jest.spyOn(store, 'conditionalDebit').mockRejectedValue(new Error(POISON))
  const wallets = new WalletService(store, { enabled: true, creditRateNanoUsd: 1_000_000_000n, overdraftNanoUsd: 0n, burnOrder: 'expiry' })
  return thrownBy(() => wallets.debit({ tenantId: 't', ownerType: 'user', ownerId: 'u' }, { amountNanoUsd: 1n, idempotencyKey: 'k', reason: 'test' }))
}

/** A markup policy that throws the poisoned message. */
function poisonedPolicy(): Promise<AiTokensException> {
  const resolver = new MarkupResolver({
    markup: {
      resolve: () => {
        throw new Error(POISON)
      },
    },
  })
  return thrownBy(() => resolver.resolve({ scope: { type: 'user', id: 'u' }, provider: 'openai', model: 'm', operation: 'chat', serviceTier: 'standard', feature: 'f' }))
}

/** An options factory that rejects with the poisoned message. */
function poisonedFactory(): Promise<AiTokensException> {
  return thrownBy(() =>
    Test.createTestingModule({
      imports: [BymaxAiTokensModule.forRootAsync({ useFactory: () => Promise.reject(new Error(POISON)) })],
    }).compile(),
  )
}

/** Each way a third party's text can reach an error, with the code the error carries. */
const CASES: readonly { name: string; code: AiTokensErrorCode; make: () => Promise<AiTokensException> | AiTokensException }[] = [
  { name: 'a driver error whose message is poisoned', code: 'AI_TOKENS_STORE_ERROR', make: () => storeError(driverError(POISON, 'P2010')) },
  { name: 'a driver error whose code is poisoned', code: 'AI_TOKENS_STORE_ERROR', make: () => storeError(driverError('boom', POISON)) },
  { name: 'a driver error that says the server is unreachable', code: 'AI_TOKENS_STORE_UNAVAILABLE', make: () => storeError(driverError(POISON, 'P1001')) },
  { name: 'a wallet store that fails', code: 'AI_TOKENS_STORE_ERROR', make: poisonedWallet },
  { name: 'a budget store that fails closed', code: 'AI_TOKENS_STORE_ERROR', make: poisonedBudget },
  { name: 'a markup policy that throws', code: 'AI_TOKENS_INVALID_CONFIG', make: poisonedPolicy },
  { name: 'an options factory that rejects', code: 'AI_TOKENS_INVALID_CONFIG', make: poisonedFactory },
]

/** Why each code the cases above do not produce cannot carry text a third party wrote. */
const EXEMPT: Readonly<Record<string, string>> = {
  AI_TOKENS_NOT_CONFIGURED: 'raised by a disabled service with a fixed reason naming the option block',
  AI_TOKENS_UNKNOWN_PROVIDER: 'carries the provider the caller passed, which is the caller’s own input',
  AI_TOKENS_USAGE_MALFORMED: 'carries a fixed reason; the normalizer’s own failure is not repeated',
  AI_TOKENS_PRICE_NOT_FOUND: 'carries the provider, model and operation the caller asked for',
  AI_TOKENS_FX_REQUIRED: 'carries the currency the caller passed',
  AI_TOKENS_BUDGET_EXCEEDED: 'carries the budget id and the amounts the library computed',
  AI_TOKENS_QUOTA_EXCEEDED: 'carries the budget id and the counts the library computed',
  AI_TOKENS_INSUFFICIENT_CREDITS: 'carries the balance and the requested amount as strings the library computed',
  AI_TOKENS_HOLD_NOT_FOUND: 'carries the hold id the caller passed',
  AI_TOKENS_HOLD_EXPIRED: 'carries the hold id the caller passed',
  AI_TOKENS_HOLD_ALREADY_SETTLED: 'carries the hold id the caller passed',
  AI_TOKENS_IDEMPOTENCY_CONFLICT: 'carries the tenant and the key the caller passed, or a fixed reason',
  AI_TOKENS_STREAM_USAGE_MISSING: 'carries a fixed reason',
}

/** The serialised response of an exception, as the HTTP body carries it. */
function bodyOf(error: AiTokensException): string {
  return JSON.stringify(error.getResponse())
}

describe('what an AiTokensException response may carry', () => {
  it.each(CASES.map((item) => [item.name, item] as const))('keeps the text of %s out of the response', async (_name, item) => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = await item.make()
    expect((error.getResponse() as { error: { code: string } }).error.code).toBe(item.code)
    expect(bodyOf(error)).not.toContain('s3cr3t')
    expect(bodyOf(error)).not.toContain('10.0.0.5')
    expect(bodyOf(error)).not.toContain('a@b.c')
  })

  /** The failure that caused the typed error rides on `cause`, which is not serialised. */
  it('keeps the original failure on the cause of a store error', () => {
    const driver = driverError(POISON, 'P2010')
    const error = storeError(driver)
    expect(error.cause).toBe(driver)
    expect(JSON.stringify(error)).not.toContain('s3cr3t')
  })

  /** A code decided here is either produced by a case or exempt with a reason, so a new one has to be decided. */
  it('decides every error code: a case produces it, or it is exempt with a reason', () => {
    const covered = new Set<string>(CASES.map((item) => item.code))
    const decided = new Set([...covered, ...Object.keys(EXEMPT)])
    expect(Object.keys(AI_TOKENS_ERROR_CODES).filter((code) => !decided.has(code))).toEqual([])
    expect(Object.keys(EXEMPT).filter((code) => covered.has(code) || !(code in AI_TOKENS_ERROR_CODES))).toEqual([])
    expect(Object.values(EXEMPT).every((reason) => reason.length > 10)).toBe(true)
  })
})
