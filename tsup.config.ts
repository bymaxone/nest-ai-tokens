import { defineConfig, type Options } from 'tsup'

/**
 * Bundling configuration for the five published subpaths. Every `@nestjs/*`
 * package, `reflect-metadata`, and the optional peers (`@prisma/client`,
 * `ioredis`, `@nestjs/event-emitter`, `@opentelemetry/api`) stay external so
 * they are never bundled — the library declares them as peer dependencies and
 * resolves them from the host application at runtime. The `shared` and `prices`
 * entries carry zero dependencies (pure types, constants, and data). Chunk
 * splitting is disabled so each subpath is a self-contained bundle with no
 * shared cross-entry chunks.
 */
const external = [
  /^@nestjs\//,
  'reflect-metadata',
  '@prisma/client',
  'ioredis',
  '@nestjs/event-emitter',
  '@opentelemetry/api',
  // The server lazily imports the ./prices subpath by its published name; keep it
  // external so it resolves from the consumer's install rather than being bundled.
  /^@bymax-one\/nest-ai-tokens/,
]

const base: Omit<Options, 'entry'> = {
  format: ['esm', 'cjs'],
  dts: true,
  tsconfig: 'tsconfig.build.json',
  outDir: 'dist',
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
  external,
  target: 'node24',
  clean: false,
  splitting: false,
  treeshake: true,
  sourcemap: false,
}

export default defineConfig([
  { ...base, entry: { 'server/index': 'src/server/index.ts' } },
  { ...base, entry: { 'shared/index': 'src/shared/index.ts' } },
  { ...base, entry: { 'prices/index': 'src/prices/index.ts' } },
  { ...base, entry: { 'prisma/index': 'src/prisma/index.ts' } },
  { ...base, entry: { 'redis/index': 'src/redis/index.ts' } },
])
