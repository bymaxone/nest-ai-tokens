/**
 * @fileoverview The aggregate persistence bundle (spec §4.1). Ledger + pricing
 * are always required; the wallet and budget halves are `Partial` and validated
 * at init only when the corresponding feature is configured.
 * @layer server
 */

import type { IBudgetStore } from './budget-store.interface'
import type { ILedgerStore } from './ledger-store.interface'
import type { IPricingStore } from './pricing-store.interface'
import type { IWalletStore } from './wallet-store.interface'

/**
 * The single store object a host provides. `forRoot()` fans it out under each
 * per-port DI token; a host may override any individual port by binding its token
 * (§4.6).
 */
export interface IAiTokensStore
  extends ILedgerStore,
    IPricingStore,
    Partial<IWalletStore>,
    Partial<IBudgetStore> {}
