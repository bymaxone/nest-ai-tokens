/**
 * @fileoverview Prisma seed script — creates demo data for the example app.
 *
 * Sets up:
 * - A demo tenant + user
 * - A monthly token budget (500k tokens, 100 operations, anchored to the 1st)
 * - A wallet with a $25 grant (25_000_000_000 nano-USD)
 *
 * Usage: pnpm prisma:seed
 *
 * Note: AI model prices are seeded automatically by PricingService.onModuleInit()
 * when `pricing.seedFromSnapshot: true` is set in `BymaxAiTokensModule.forRootAsync()`.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main(): Promise<void> {
  const tenantId = 'tenant-demo'
  const userId = 'user-demo'

  console.log('Seeding demo tenant and user...')

  // Create demo user
  await prisma.user.upsert({
    where: { email: 'demo@example.com' },
    update: {},
    create: {
      id: userId,
      tenantId,
      email: 'demo@example.com',
      name: 'Demo User',
      role: 'USER',
    },
  })

  console.log(`Created user ${userId} in tenant ${tenantId}`)

  // Create demo wallet
  await prisma.aiWallet.upsert({
    where: { tenantId_ownerType_ownerId_currency: { tenantId, ownerType: 'user', ownerId: userId, currency: 'nano-USD' } },
    update: {},
    create: {
      tenantId,
      ownerType: 'user',
      ownerId: userId,
      currency: 'nano-USD',
      balance: 25_000_000_000n, // $25 in nano-USD
    },
  })

  console.log('Created demo wallet with $25 balance')

  // Create monthly token budget (500k tokens, 100 operations — spec §21.5)
  const nextMonth = new Date()
  nextMonth.setMonth(nextMonth.getMonth() + 1)
  nextMonth.setDate(1)
  nextMonth.setHours(0, 0, 0, 0)

  const anchor = new Date()
  anchor.setDate(1)
  anchor.setHours(0, 0, 0, 0)

  await prisma.aiBudget.upsert({
    where: {
      tenantId_scopeType_scopeId_features_window_anchorAt: {
        tenantId,
        scopeType: 'user',
        scopeId: userId,
        features: ['chat.reply', 'doc.summarize', 'workout.generate'],
        window: 'month',
        anchorAt: anchor,
      },
    },
    update: {},
    create: {
      tenantId,
      scopeType: 'user',
      scopeId: userId,
      features: ['chat.reply', 'doc.summarize', 'workout.generate'],
      window: 'month',
      anchorAt: anchor,
      limitTokens: 500_000n,  // 500k token monthly cap
      limitCount: 100n,       // 100 AI operations per month
      softThresholds: [0.8, 1.0],
      policy: 'block',
    },
  })

  console.log('Created monthly budget: 500k tokens / 100 operations')
  console.log('\nSeed complete. Run: pnpm start:dev')
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err)
    void prisma.$disconnect()
    process.exit(1)
  })
