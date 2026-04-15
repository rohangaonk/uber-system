import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { GEO_KEY, LAST_SEEN_KEY } from './drivers.service';

const STALE_THRESHOLD_MS = 30_000;

@Injectable()
export class DriversCleanupService {
  private readonly logger = new Logger(DriversCleanupService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async cleanupStaleDrivers(): Promise<void> {
    const threshold = Date.now() - STALE_THRESHOLD_MS;

    // ZRANGEBYSCORE returns all members with score < threshold (last seen > 30s ago)
    const stale = await this.redis.zrangebyscore(
      LAST_SEEN_KEY,
      '-inf',
      threshold,
    );
    if (stale.length === 0) return;

    // Remove from both the geo set and the last-seen sorted set atomically
    await Promise.all([
      this.redis.zrem(LAST_SEEN_KEY, ...stale),
      this.redis.zrem(GEO_KEY, ...stale),
    ]);

    this.logger.log(
      `Removed ${stale.length} stale driver(s) from location index`,
    );
  }
}
