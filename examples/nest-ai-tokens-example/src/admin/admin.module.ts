/**
 * @fileoverview AdminModule — privileged admin-plane feature module.
 * @layer module
 */
import { Module } from '@nestjs/common'
import { AdminController } from './admin.controller.js'

/**
 * Feature module for admin-plane billing operations.
 * Services (WalletService, BudgetService, LedgerService, UsageReportService)
 * are provided globally by `BymaxAiTokensModule`.
 */
@Module({
  controllers: [AdminController],
})
export class AdminModule {}
