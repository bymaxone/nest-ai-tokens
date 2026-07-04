/**
 * @fileoverview Auth decorators and types for the example app.
 *
 * In a real app these would come from a JWT guard or session middleware.
 * Here the tenant and user IDs are read directly from headers for simplicity.
 *
 * @layer presentation
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'

/** Authenticated user shape attached to every request. */
export interface AuthedUser {
  readonly tenantId: string
  readonly userId: string
  readonly role: 'user' | 'admin'
}

/**
 * Extracts the authenticated user from the request.
 * In this example, `x-tenant-id` and `x-user-id` headers stand in for a real JWT.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthedUser => {
  const req = ctx.switchToHttp().getRequest<Request & { user?: AuthedUser }>()
  // In the example, use headers as the identity source (no real auth needed).
  const tenantId = (req.headers['x-tenant-id'] as string | undefined) ?? 'tenant-demo'
  const userId = (req.headers['x-user-id'] as string | undefined) ?? 'user-demo'
  const role = (req.headers['x-role'] as string | undefined) === 'admin' ? 'admin' : 'user'
  return { tenantId, userId, role }
})
