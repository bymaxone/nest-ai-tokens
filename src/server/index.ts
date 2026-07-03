/**
 * @fileoverview Public barrel for the main `.` (server) subpath — the NestJS
 * dynamic module, services, guard, interceptor, decorators, ports, and errors.
 * Re-exports the full `./shared` surface for single-import ergonomics.
 * @layer server
 */

export * from './errors'
export type * from './interfaces'
