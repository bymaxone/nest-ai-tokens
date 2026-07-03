/**
 * @fileoverview Public barrel for the error layer — exports only the typed
 * exception. The code catalog and error-response type are re-exported by the
 * server entry from `./shared`; the message/status maps are internal.
 * @layer server
 */

export { AiTokensException } from './ai-tokens-exception'
