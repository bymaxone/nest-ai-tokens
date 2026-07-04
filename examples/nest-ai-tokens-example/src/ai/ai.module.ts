/**
 * @fileoverview AiModule — feature module for AI metering demonstration.
 * @layer module
 */
import { Module } from '@nestjs/common'
import { AiController } from './ai.controller.js'
import { AiService } from './ai.service.js'
import { FakeLlmService } from '../fake-llm/fake-llm.service.js'

/**
 * Feature module bundling the AI controller and service.
 * `FakeLlmService` replaces a real OpenAI/Anthropic client for the example.
 */
@Module({
  controllers: [AiController],
  providers: [AiService, FakeLlmService],
})
export class AiModule {}
