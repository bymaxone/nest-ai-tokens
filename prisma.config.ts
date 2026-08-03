import { defineConfig } from 'prisma/config'

/**
 * Prisma CLI configuration.
 *
 * Prisma 7 removed the `url` property from `datasource` blocks, so the connection
 * string the CLI needs lives here instead. It is a generate-time placeholder and
 * nothing more: `prisma generate` never opens a connection, and the library never
 * builds a `PrismaClient` — the host application constructs one and passes it to
 * `PrismaAiTokensStore`. Keeping the value literal rather than reading an env var
 * lets `prisma generate` run out of the box with no `DATABASE_URL` or `.env`
 * present, which is what `pnpm prepare` depends on.
 *
 * The end-to-end suite talks to a real database through a Testcontainers Postgres
 * and its own driver adapter; it does not read this file.
 */
export default defineConfig({
  schema: './prisma/schema.prisma',
  datasource: {
    url: 'postgresql://localhost:5432/ai_tokens_dev?schema=public'
  }
})
