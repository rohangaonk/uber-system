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
import {
  DRIVER_LOCK_KEY,
  REJECTED_SET_KEY,
  TIMEOUT_HASH_KEY,
} from './matching.consumer';

interface DriverResponsePayload {
  rideId: string;
  driverId: string;
  decision: 'accept' | 'reject';
}

@Controller()
export class RideConfirmationConsumer {
  private readonly logger = new Logger(RideConfirmationConsumer.name);

  constructor(
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    private readonly driversService: DriversService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(KAFKA_CLIENT) private readonly kafkaClient: ClientKafka,
  ) {}

  @EventPattern(KAFKA_TOPICS.DRIVER_RESPONSE)
  async handleDriverResponse(@Payload() data: DriverResponsePayload): Promise<void> {
    const { rideId, driverId, decision } = data;

    if (decision === 'accept') {
      await this.handleAccept(rideId, driverId);
    } else {
      await this.handleReject(rideId, driverId);
    }
  }

  private async handleAccept(rideId: string, driverId: string): Promise<void> {
    const result = await this.rideRepository
      .createQueryBuilder()
      .update(Ride)
      .set({ status: RideStatus.CONFIRMED, driverId, offeredDriverId: null, offerExpiresAt: null })
      .where('id = :rideId AND status = :status AND offered_driver_id = :driverId', {
        rideId,
        status: RideStatus.DRIVER_OFFERED,
        driverId,
      })
      .execute();

    if ((result.affected ?? 0) === 0) {
      this.logger.warn(`Ride ${rideId} accept by driver ${driverId} lost the race — discarding`);
      return;
    }

    // Mark driver unavailable and release coordination keys
    await Promise.all([
      this.driversService.setAvailability(driverId, false),
      this.redis.del(DRIVER_LOCK_KEY(driverId)),
      this.redis.del(REJECTED_SET_KEY(rideId)),
      this.redis.del(TIMEOUT_HASH_KEY(rideId)),
    ]);

    this.logger.log(`Ride ${rideId} confirmed with driver ${driverId}`);
  }

  private async handleReject(rideId: string, driverId: string): Promise<void> {
    // Add to rejected set and release lock
    await Promise.all([
      this.redis.sadd(REJECTED_SET_KEY(rideId), driverId),
      this.redis.del(DRIVER_LOCK_KEY(driverId)),
    ]);

    // Reset ride back to ride_requested so the matching consumer retries
    const result = await this.rideRepository
      .createQueryBuilder()
      .update(Ride)
      .set({ status: RideStatus.RIDE_REQUESTED, offeredDriverId: null, offerExpiresAt: null })
      .where('id = :rideId AND status = :status AND offered_driver_id = :driverId', {
        rideId,
        status: RideStatus.DRIVER_OFFERED,
        driverId,
      })
      .execute();

    if ((result.affected ?? 0) === 0) {
      this.logger.warn(`Ride ${rideId} reject by driver ${driverId} lost the race — discarding`);
      return;
    }

    // Re-trigger the matching loop
    const ride = await this.rideRepository.findOne({
      where: { id: rideId },
      relations: ['fare'],
    });

    if (ride?.fare) {
      this.kafkaClient.emit(KAFKA_TOPICS.RIDE_REQUESTED, {
        key: rideId,
        value: {
          rideId,
          riderId: ride.riderId,
          source: ride.source,
          destination: ride.destination,
          sourceLat: ride.fare.sourceLat,
          sourceLon: ride.fare.sourceLon,
        },
      });
      this.logger.log(`Ride ${rideId} rejected by driver ${driverId} — re-queuing for matching`);
    }
  }
}
