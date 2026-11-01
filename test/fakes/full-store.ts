/**
 * @fileoverview An `IAiTokensStore` assembled from the four in-memory halves, with every port
 * method backed by a real store. A spec that needs wallets, budgets and a ledger at once builds
 * its store here instead of rejecting the halves it does not use.
 * @layer test
 */

import type { IAiTokensStore } from '../../src/server/interfaces'
import { InMemoryBudgetStore } from './in-memory-budget-store'
import { InMemoryLedgerStore } from './in-memory-ledger-store'
import { InMemoryPricingStore } from './in-memory-pricing-store'
import { InMemoryWalletStore } from './in-memory-wallet-store'

/** A store whose four halves are all live. */
export function makeFullStore(): IAiTokensStore {
  const ledger = new InMemoryLedgerStore()
  const pricing = new InMemoryPricingStore()
  const wallet = new InMemoryWalletStore()
  const budget = new InMemoryBudgetStore()
  return {
    append: ledger.append.bind(ledger),
    transition: ledger.transition.bind(ledger),
    findByIdempotencyKey: ledger.findByIdempotencyKey.bind(ledger),
    findById: ledger.findById.bind(ledger),
    findExpiredHolds: ledger.findExpiredHolds.bind(ledger),
    query: ledger.query.bind(ledger),
    sumCost: ledger.sumCost.bind(ledger),
    lastHash: ledger.lastHash.bind(ledger),
    resolveRate: pricing.resolveRate.bind(pricing),
    upsertPrice: pricing.upsertPrice.bind(pricing),
    seedPrice: pricing.seedPrice.bind(pricing),
    getPriceHistory: pricing.getPriceHistory.bind(pricing),
    listModels: pricing.listModels.bind(pricing),
    getWallet: wallet.getWallet.bind(wallet),
    appendEntry: wallet.appendEntry.bind(wallet),
    conditionalDebit: wallet.conditionalDebit.bind(wallet),
    openGrants: wallet.openGrants.bind(wallet),
    listEntries: wallet.listEntries.bind(wallet),
    reconcile: wallet.reconcile.bind(wallet),
    upsert: budget.upsert.bind(budget),
    remove: budget.remove.bind(budget),
    findBudgetById: budget.findBudgetById.bind(budget),
    findMatching: budget.findMatching.bind(budget),
    conditionalConsume: budget.conditionalConsume.bind(budget),
    adjustWindow: budget.adjustWindow.bind(budget),
    getWindow: budget.getWindow.bind(budget),
    setWindowStart: budget.setWindowStart.bind(budget),
  }
}
