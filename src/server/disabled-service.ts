/**
 * @fileoverview The stand-in `forRootAsync` registers for a feature the options leave out.
 * Async options resolve after the providers are declared, so the module cannot leave a disabled
 * service unregistered the way `forRoot` does. The stand-in keeps the injected value non-null
 * and answers every method call with `AI_TOKENS_INVALID_CONFIG`, so the mistake surfaces at the
 * call that needs the feature rather than as a null dereference somewhere else.
 * @layer server
 */

import { AiTokensException } from './errors'

/** Marks a stand-in so the module can pass `null` to its own wiring instead of the stand-in. */
const DISABLED = Symbol('bymax.ai-tokens.disabled-service')

/**
 * A stand-in for `Service`: every method the class defines throws `AI_TOKENS_INVALID_CONFIG`
 * naming the missing options block; any other property reads as `undefined`, which keeps Nest's
 * lifecycle-hook and promise checks from invoking it.
 *
 * @param service The class being stood in for (its prototype names the methods).
 * @param block The options block that enables it, for the error message.
 * @returns An object typed as `Service`.
 */
export function disabledService<Service extends object>(
  service: abstract new (...args: never[]) => Service,
  block: 'wallets' | 'budgets',
): Service {
  const methods = new Set(
    Object.getOwnPropertyNames(service.prototype).filter((name) => name !== 'constructor'),
  )
  const fail = (): never => {
    throw new AiTokensException('AI_TOKENS_INVALID_CONFIG', undefined, {
      reason: `${block} not configured: set options.${block} to enable ${service.name}`,
    })
  }
  return new Proxy({} as Service, {
    get: (_target, property) => {
      if (property === DISABLED) return true
      return typeof property === 'string' && methods.has(property) ? fail : undefined
    },
  })
}

/** `null` for a stand-in or an absent service, the service itself otherwise. */
export function liveService<Service extends object>(service: Service | null | undefined): Service | null {
  if (service === null || service === undefined) return null
  return (service as Record<symbol, unknown>)[DISABLED] === true ? null : service
}
