/**
 * Host probe of the consumer runtime gate.
 *
 * Boots a real Nest application, over HTTP, against the packed tarball, with the controller that the README's
 * "Enforced metering via guard + interceptor" step shows, lifted out of the README itself and compiled the way a host
 * compiles it (`tsc`, with `emitDecoratorMetadata`). A class the host names in `@UseGuards` or `@UseInterceptors` is built
 * by Nest from that class's own constructor metadata, which the published build does not carry unless each parameter
 * names its token, so no source-based gate can see a guard that does not boot. Once it boots, the probe proves the guard
 * acts: a request under budget passes and is billed, an exhausted budget answers 402 or 429 and a hold larger than the
 * budget answers 402, all before the handler runs.
 *
 * Only the fake store is bundled from `test/fakes`; everything the probe exercises of the library comes from the tarball.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const STEP_HEADING = '### 4 — Enforced metering via guard + interceptor'

/** The first typescript fence under the README step heading, as text. Throws when the step is not there. */
export function readmeStepSource(rootDir) {
  const readme = readFileSync(join(rootDir, 'README.md'), 'utf8')
  const at = readme.indexOf(STEP_HEADING)
  if (at < 0) throw new Error(`README.md has no "${STEP_HEADING}" step`)
  const open = readme.indexOf('```typescript\n', at)
  const close = readme.indexOf('\n```', open + 1)
  if (open < 0 || close < 0) throw new Error('the README step has no typescript fence')
  return readme.slice(open + '```typescript\n'.length, close + 1)
}

/** The driver, plain CommonJS: it does what a host's `main.ts` does, then asserts over HTTP. */
const driver = `
require('reflect-metadata')
const { Module, Controller, Post, UseGuards, UseInterceptors } = require('@nestjs/common')
const { NestFactory } = require('@nestjs/core')
const lib = require('@bymax-one/nest-ai-tokens')
const { makeFullStore } = require('./store.cjs')
const { AiService } = require('./ai.service')
const { AiController } = require('./snippet')

const failures = []
const expect = (ok, what) => { if (!ok) failures.push(what) }

// A host that holds a bare { tokens } estimate: no model named, so under strict pricing its settle has no price.
class BareController {
  calls = 0
  summarize() { this.calls += 1; return { ok: true } }
}
Controller('bare')(BareController)
Post('summarize')(BareController.prototype, 'summarize', Object.getOwnPropertyDescriptor(BareController.prototype, 'summarize'))
lib.RequireBudget({ estimate: { tokens: 3000 } })(BareController.prototype, 'summarize', Object.getOwnPropertyDescriptor(BareController.prototype, 'summarize'))
lib.Meter({ preset: lib.providerPresets.anthropic })(BareController.prototype, 'summarize', Object.getOwnPropertyDescriptor(BareController.prototype, 'summarize'))
UseGuards(lib.BudgetGuard)(BareController)
UseInterceptors(lib.MeteringInterceptor)(BareController)

class AppModule {}
Module({
  imports: [
    lib.BymaxAiTokensModule.forRoot({
      store: makeFullStore(),
      markup: 4,
      budgets: { defaultPolicy: 'block', alertThresholds: [0.8, 1.0] },
      scopeResolver: (ctx) => {
        const { user } = ctx.switchToHttp().getRequest()
        return { tenantId: user.tenantId, scope: { type: 'user', id: user.id }, feature: 'doc.summarize' }
      },
      pricing: { seedFromSnapshot: true },
    }),
  ],
  controllers: [AiController, BareController],
  providers: [AiService],
})(AppModule)

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false })
  app.use((req, _res, next) => {
    req.user = { tenantId: req.headers['x-tenant'], id: 'u1' }
    next()
  })
  await app.listen(0)
  const url = await app.getUrl()
  const budgets = app.get(lib.BudgetService)
  const ai = app.get(AiService)
  const post = async (tenant) => {
    const before = ai.calls
    const res = await fetch(url + '/ai/summarize', { method: 'POST', headers: { 'x-tenant': tenant, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello world' }) })
    const text = await res.text()
    let code, details
    try { const error = JSON.parse(text).error; code = error?.code; details = error?.details } catch { code = undefined }
    return { status: res.status, code, details, headers: res.headers, handlerRan: ai.calls !== before }
  }
  const budget = (tenant, limit) => budgets.upsertBudget({ tenantId: tenant, scope: { type: 'tenant', id: tenant }, window: 'month', ...limit })

  // Under budget: the request passes the guard, the handler runs, and the interceptor settles the hold and bills it.
  await budget('under', { limitNanoUsd: 1_000_000_000_000n })
  const under = await post('under')
  expect(under.status === 201, 'under budget answered ' + under.status + ' (' + under.code + ') instead of 201')
  expect(under.handlerRan, 'the handler did not run under budget')
  const raw = BigInt(under.headers.get('x-ai-tokens-cost') ?? '-1')
  const billed = BigInt(under.headers.get('x-ai-tokens-billed-cost') ?? '-1')
  expect(raw > 0n && billed === raw * 4n, 'the settle did not bill the call: cost ' + raw + ', billed ' + billed + ' at markup 4')
  const spent = (await budgets.status('under', { type: 'tenant', id: 'under' }))[0]?.spent.nanoUsd
  expect(spent === billed, 'the budget did not take the billed cost: spent ' + spent + ', billed ' + billed)

  // No budget row is unlimited.
  const unlimited = await post('unlimited')
  expect(unlimited.status === 201, 'no budget row answered ' + unlimited.status + ' instead of 201')

  // A spend limit of 0 is a hard block, answered before the handler.
  await budget('zero', { limitNanoUsd: 0n })
  const zero = await post('zero')
  // The guard's own refusal names the budget and the dimension; a refusal by the hold that follows it carries neither, so a guard that stopped checking is seen.
  expect(zero.status === 402 && zero.code === 'AI_TOKENS_BUDGET_EXCEEDED' && !zero.handlerRan && zero.details?.dimension === 'cost' && typeof zero.details?.budgetId === 'string', 'a spend limit of 0 answered ' + zero.status + ' ' + zero.code + ', handler ran: ' + zero.handlerRan)

  // A token limit below the hold is a quota error, answered before the handler.
  await budget('quota', { limitTokens: 100 })
  const quota = await post('quota')
  expect(quota.status === 429 && quota.code === 'AI_TOKENS_QUOTA_EXCEEDED' && !quota.handlerRan && quota.details?.dimension === 'tokens' && typeof quota.details?.budgetId === 'string', 'a token limit of 100 answered ' + quota.status + ' ' + quota.code + ', handler ran: ' + quota.handlerRan)

  // A hold larger than what the budget has left is refused by the hold itself, in hold mode.
  await budget('small', { limitNanoUsd: 1_000n })
  const small = await post('small')
  expect(small.status === 402 && !small.handlerRan, 'a hold over a 1000 nano-USD budget answered ' + small.status + ' ' + small.code + ', handler ran: ' + small.handlerRan)

  // Strict pricing (the default) and a rate table: an estimate that names no model is refused before the handler, with nothing held.
  await budget('bare', { limitNanoUsd: 1_000_000_000_000n })
  const bareBefore = app.get(BareController).calls
  const bareRes = await fetch(url + '/bare/summarize', { method: 'POST', headers: { 'x-tenant': 'bare' } })
  const bareCode = (await bareRes.json().catch(() => ({}))).error?.code
  expect(bareRes.status === 500 && bareCode === 'AI_TOKENS_INVALID_CONFIG' && app.get(BareController).calls === bareBefore, 'a model-less estimate under strict pricing answered ' + bareRes.status + ' ' + bareCode + ' instead of 500 AI_TOKENS_INVALID_CONFIG before the handler')
  expect((await budgets.status('bare', { type: 'tenant', id: 'bare' }))[0]?.spent.nanoUsd === 0n, 'the refused model-less estimate took budget')

  await app.close()
  if (failures.length) {
    for (const failure of failures) console.error('  ✗ ' + failure)
    process.exit(1)
  }
  console.log('  ✓ host: the README controller boots against the packed tarball, passes under budget and answers 402/429 over it')
}

main().catch((error) => {
  console.error('  ✗ host probe crashed: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
`

/** A stand-in for the host's wrapper over a provider SDK, counting the calls that reach it. */
const aiService = `
class AiService {
  calls = 0
  summarize(content) {
    this.calls += 1
    return { summary: content.slice(0, 5), response: { id: 'msg_1', model: 'claude-opus-4', usage: { input_tokens: 1000, output_tokens: 500 } } }
  }
}
module.exports = { AiService }
`

/**
 * Lay out the host under `consumerDir/host` and return the command that runs it.
 *
 * @param rootDir This repository.
 * @param consumerDir The consumer directory the tarball is already extracted into.
 */
export function prepareHostProbe(rootDir, consumerDir) {
  const repoRequire = createRequire(join(rootDir, 'package.json'))
  const ts = repoRequire('typescript')
  // tsup bundles with esbuild, so esbuild is resolved from where tsup resolves it.
  const esbuild = createRequire(repoRequire.resolve('tsup'))('esbuild')
  const hostDir = join(consumerDir, 'host')
  mkdirSync(hostDir, { recursive: true })
  writeFileSync(join(hostDir, 'package.json'), '{ "type": "commonjs" }\n')

  // The README controller, compiled the way a host compiles it: `tsc` with decorator metadata on.
  const compiled = ts.transpileModule(readmeStepSource(rootDir), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, emitDecoratorMetadata: true },
  })
  writeFileSync(join(hostDir, 'snippet.js'), compiled.outputText)
  writeFileSync(join(hostDir, 'ai.service.js'), aiService)

  // The fake store is the one the unit suites use. It reaches into `src`, so it is bundled whole; the host never sees those copies.
  esbuild.buildSync({
    stdin: { contents: "export { makeFullStore } from './test/fakes/full-store'", resolveDir: rootDir, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: join(hostDir, 'store.cjs'),
    alias: { '@bymax-one/nest-ai-tokens/shared': join(rootDir, 'src/shared/index.ts'), '@bymax-one/nest-ai-tokens': join(rootDir, 'src/server/index.ts') },
    external: ['@nestjs/*', 'rxjs', 'reflect-metadata'],
    logLevel: 'silent',
  })
  writeFileSync(join(hostDir, 'driver.js'), driver)
  return { command: 'node', args: ['driver.js'], cwd: hostDir }
}
