import { Controller, Inject, Logger } from '@nestjs/common';
import { ClientKafka, EventPattern, Payload } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import { Ride } from './ride.entity';
import { RideStatus } from './ride-status.enum';
import { DriversService } from '../drivers/drivers.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { KAFKA_CLIENT, KAFKA_TOPICS } from '../kafka/kafka.constants';

export const DRIVER_LOCK_KEY = (driverId: string) => `driver:lock:${driverId}`;
export const REJECTED_SET_KEY = (rideId: string) => `ride:rejected:${rideId}`;
export const TIMEOUT_HASH_KEY = (rideId: string) => `ride:timed_out:${rideId}`;
const LOCK_TTL_MS = 10_000;
const REJECTED_TTL_S = 120;
const MAX_TIMEOUTS_BEFORE_SKIP = 2;

interface RideRequestedPayload {
  rideId: string;
  riderId: string;
  source: string;
  destination: string;
  sourceLat: number;
  sourceLon: number;
}

@Controller()
export class MatchingConsumer {
  private readonly logger = new Logger(MatchingConsumer.name);

  constructor(
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    private readonly driversService: DriversService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(KAFKA_CLIENT) private readonly kafkaClient: ClientKafka,
  ) {}

  @EventPattern(KAFKA_TOPICS.RIDE_REQUESTED)
  async handleRideRequested(
    @Payload() data: RideRequestedPayload,
  ): Promise<void> {
    const { rideId, sourceLat, sourceLon } = data;

    const ride = await this.rideRepository.findOne({ where: { id: rideId } });
    if (!ride) {
      this.logger.warn(`Ride ${rideId} not found — skipping`);
      return;
    }

    // Ignore if already handled (confirmed, cancelled, etc.)
    if (ride.status !== RideStatus.RIDE_REQUESTED) {
      this.logger.log(`Ride ${rideId} is in status ${ride.status} — skipping`);
      return;
    }

    // 1. Check matching deadline
    if (new Date() > ride.matchingDeadline) {
      this.logger.log(
        `Ride ${rideId} matching deadline elapsed — marking no_driver_found`,
      );
      await this.rideRepository
        .createQueryBuilder()
        .update(Ride)
        .set({ status: RideStatus.NO_DRIVER_FOUND })
        .where('id = :rideId AND status = :status', {
          rideId,
          status: RideStatus.RIDE_REQUESTED,
        })
        .execute();
      return;
    }

    // 2. Load rejection and timeout sets from Redis
    const [rejectedIds, timeoutHash] = await Promise.all([
      this.redis.smembers(REJECTED_SET_KEY(rideId)),
      this.redis.hgetall(TIMEOUT_HASH_KEY(rideId)),
    ]);
    const rejectedSet = new Set(rejectedIds);
    const timeoutCounts: Record<string, number> = {};
    for (const [driverId, count] of Object.entries(timeoutHash ?? {})) {
      timeoutCounts[driverId] = parseInt(count, 10);
    }

    // 3. Find nearby available drivers
    const candidates = await this.driversService.findNearby(
      sourceLat,
      sourceLon,
      5,
    );

    // 4. Filter out permanently skipped drivers
    const eligible = candidates.filter((c) => {
      if (rejectedSet.has(c.driverId)) return false;
      if ((timeoutCounts[c.driverId] ?? 0) >= MAX_TIMEOUTS_BEFORE_SKIP)
        return false;
      return true;
    });

    if (eligible.length === 0) {
      this.logger.log(`Ride ${rideId} — no eligible candidates, re-queuing`);
      this.kafkaClient.emit(KAFKA_TOPICS.RIDE_REQUESTED, {
        key: rideId,
        value: data,
      });
      return;
    }

    // 5. Try to lock a driver (closest first)
    for (const candidate of eligible) {
      const lockKey = DRIVER_LOCK_KEY(candidate.driverId);
      const acquired = await this.redis.set(
        lockKey,
        rideId,
        'PX',
        LOCK_TTL_MS,
        'NX',
      );

      if (acquired !== 'OK') {
        // Driver is currently locked by another ride offer — skip
        continue;
      }

      // 6. Transition ride to driver_offered (conditional update)
      const offerExpiresAt = new Date(Date.now() + LOCK_TTL_MS);
      const result = await this.rideRepository
        .createQueryBuilder()
        .update(Ride)
        .set({
          status: RideStatus.DRIVER_OFFERED,
          offeredDriverId: candidate.driverId,
          offerExpiresAt,
        })
        .where('id = :rideId AND status = :status', {
          rideId,
          status: RideStatus.RIDE_REQUESTED,
        })
        .execute();

      if ((result.affected ?? 0) === 0) {
        // Race condition — another consumer already handled this ride
        await this.redis.del(lockKey);
        this.logger.warn(`Ride ${rideId} was already claimed — releasing lock`);
        return;
      }

      this.logger.log(
        `Ride ${rideId} offered to driver ${candidate.driverId} (${candidate.distanceKm.toFixed(2)} km away)`,
      );

      // Ensure rejected/timeout keys have a TTL so Redis auto-cleans them
      await Promise.all([
        this.redis.expire(REJECTED_SET_KEY(rideId), REJECTED_TTL_S),
        this.redis.expire(TIMEOUT_HASH_KEY(rideId), REJECTED_TTL_S),
      ]);
      return;
    }

    // All candidates were locked — re-queue and let the next iteration try
    this.logger.log(`Ride ${rideId} — all candidates locked, re-queuing`);
    this.kafkaClient.emit(KAFKA_TOPICS.RIDE_REQUESTED, {
      key: rideId,
      value: data,
    });
  }
}
