/**
 * @fileoverview The guard as a host references it: `@UseGuards(BudgetGuard)` makes Nest resolve the class by its constructor's own metadata,
 * and the published build carries none (it is built without `emitDecoratorMetadata`), so every parameter has to name its token itself.
 * @layer server
 */
import { Controller, Get, UseGuards } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { BYMAX_AI_TOKENS_OPTIONS } from '../bymax-ai-tokens.constants'
import { BudgetService, MeteringService, PricingService } from '../services'
import { BudgetGuard } from './budget.guard'

@Controller('probe')
@UseGuards(BudgetGuard)
class ProbeController {
  @Get()
  ping(): string {
    return 'ok'
  }
}

describe('BudgetGuard resolved by Nest from a host controller', () => {
  /** A guard whose parameters carry no metadata and no @Inject cannot be built: Nest reports the first dependency as `?`. */
  it('is built from the providers of the module, with no compiler metadata', async () => {
    const module = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: BudgetService, useValue: {} },
        { provide: MeteringService, useValue: {} },
        { provide: PricingService, useValue: {} },
        { provide: BYMAX_AI_TOKENS_OPTIONS, useValue: { scopeResolver: () => ({ tenantId: 't', scope: { type: 'user', id: 'u' }, feature: 'f' }) } },
        Reflector,
      ],
    }).compile()
    expect(module.get(ProbeController)).toBeInstanceOf(ProbeController)
    await module.close()
  })
})
