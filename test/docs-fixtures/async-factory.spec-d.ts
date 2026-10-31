/**
 * @fileoverview Type-check-only fixture: `forRootAsync({ useFactory })` accepts a factory with
 * typed parameters, the form normal Nest code writes (`(config: ConfigService) => ...`), and
 * stays callable. Compiled by `pnpm docs:check`; never executed.
 */

import { BymaxAiTokensModule } from '@bymax-one/nest-ai-tokens'
import type { BymaxAiTokensModuleAsyncOptions, BymaxAiTokensModuleOptions, IAiTokensStore } from '@bymax-one/nest-ai-tokens'

declare const store: IAiTokensStore
declare class ConfigService {
  get(key: string): string
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// A typed parameter is accepted inline, which `(...args: unknown[]) => ...` rejected.
BymaxAiTokensModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({ store, markup: Number(config.get('MARKUP')) }),
})

// An async factory with two typed parameters is accepted too.
BymaxAiTokensModule.forRootAsync({
  inject: [ConfigService, 'EXTRA'],
  useFactory: async (config: ConfigService, extra: { flag: boolean }) => ({
    store,
    markup: extra.flag ? 2 : Number(config.get('MARKUP')),
  }),
})

// The pre-existing variadic form still fits.
export const variadic: BymaxAiTokensModuleAsyncOptions = { useFactory: (...args: unknown[]) => ({ store, markup: args.length }) }

// The factory stays callable with arguments and keeps its return type.
export type AsyncFactoryStaysCallable = Expect<
  Equal<
    ReturnType<NonNullable<BymaxAiTokensModuleAsyncOptions['useFactory']>>,
    BymaxAiTokensModuleOptions | Promise<BymaxAiTokensModuleOptions>
  >
>
export type AsyncFactoryAcceptsAnArgumentWhenCalled = Expect<
  [ConfigService] extends Parameters<NonNullable<BymaxAiTokensModuleAsyncOptions['useFactory']>> ? true : false
>
