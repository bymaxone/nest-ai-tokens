/**
 * @fileoverview Public barrel for the main `.` (server) subpath — the NestJS
 * dynamic module, services, presets, ports, DI tokens, and errors. Re-exports the
 * full `./shared` surface so server consumers use a single import; `./shared`
 * exists for frontends/workers/edge code that must stay NestJS-free (§3.3).
 * @layer server
 */

export { BymaxAiTokensModule } from './bymax-ai-tokens.module'
export * from './bymax-ai-tokens.constants'
export { PricingService, LedgerService, MeteringService } from './services'
export type { ResolveRateInput, LedgerAppendInput, RecordInput, EstimateCostInput } from './services'
export { toJsonSafe } from './utils/to-json-safe'
export type { JsonSafe } from './utils/to-json-safe'
export { providerPresets } from './config/provider-presets'
export * from './errors'
export type * from './interfaces'

// Re-export rule (family precedent): the server entry re-exports every ./shared symbol.
export * from '../shared'
