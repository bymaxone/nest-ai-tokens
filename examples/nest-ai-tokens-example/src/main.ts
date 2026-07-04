/**
 * @fileoverview Application bootstrap — starts the NestJS HTTP server.
 * @layer infrastructure
 */
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

/** Bootstraps and starts the NestJS application. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  const port = parseInt(process.env['PORT'] ?? '3000', 10)
  await app.listen(port)
  console.log(`nest-ai-tokens-example running on http://localhost:${port}`)
}

void bootstrap()
