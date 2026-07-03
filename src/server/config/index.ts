/**
 * @fileoverview Internal barrel for the configuration layer — options validation,
 * defaults resolution, and the resolved-options types. `validateOptions` and
 * `applyDefaults` are consumed by the dynamic module; they are not public API.
 * @layer server
 */

export { validateOptions } from './validate-options'
export { applyDefaults } from './apply-defaults'
export { DEFAULT_AI_TOKENS_OPTIONS } from './default-options.constants'
export type * from './resolved-options'
