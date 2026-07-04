/**
 * @fileoverview PrismaService — thin NestJS wrapper around the Prisma client.
 * @layer infrastructure
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

/**
 * NestJS-integrated Prisma client that connects on module init
 * and disconnects on module destroy.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect()
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}
