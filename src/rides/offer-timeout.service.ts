import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { ClientKafka } from '@nestjs/microservices';
import Redis from 'ioredis';
import { Ride } from './ride.entity';
import { RideStatus } from './ride-status.enum';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { KAFKA_CLIENT, KAFKA_TOPICS } from '../kafka/kafka.constants';
import { DRIVER_LOCK_KEY, TIMEOUT_HASH_KEY } from './matching.consumer';

@Injectable()
export class OfferTimeoutService {
  private readonly logger = new Logger(OfferTimeoutService.name);

  constructor(
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(KAFKA_CLIENT) private readonly kafkaClient: ClientKafka,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async handleExpiredOffers(): Promise<void> {
    const expiredRides = await this.rideRepository.find({
      where: {
        status: RideStatus.DRIVER_OFFERED,
        offerExpiresAt: LessThan(new Date()),
      },
      relations: ['fare'],
    });

    for (const ride of expiredRides) {
      const driverId = ride.offeredDriverId;
      if (!driverId) continue;

      this.logger.log(
        `Ride ${ride.id} offer to driver ${driverId} expired — resetting`,
      );

      // Increment timeout count for this driver on this ride
      await this.redis.hincrby(TIMEOUT_HASH_KEY(ride.id), driverId, 1);

      // Release the driver lock
      await this.redis.del(DRIVER_LOCK_KEY(driverId));

      // Conditional reset — only if still driver_offered (guard against race with accept)
      const result = await this.rideRepository
        .createQueryBuilder()
        .update(Ride)
        .set({
          status: RideStatus.RIDE_REQUESTED,
          offeredDriverId: null,
          offerExpiresAt: null,
        })
        .where(
          'id = :rideId AND status = :status AND offered_driver_id = :driverId',
          {
            rideId: ride.id,
            status: RideStatus.DRIVER_OFFERED,
            driverId,
          },
        )
        .execute();

      if ((result.affected ?? 0) === 0) {
        // Race condition — ride was just accepted/cancelled, discard
        this.logger.log(
          `Ride ${ride.id} timeout cron lost the race — discarding`,
        );
        continue;
      }

      // Re-trigger matching loop
      if (ride.fare) {
        this.kafkaClient.emit(KAFKA_TOPICS.RIDE_REQUESTED, {
          key: ride.id,
          value: {
            rideId: ride.id,
            riderId: ride.riderId,
            source: ride.source,
            destination: ride.destination,
            sourceLat: ride.fare.sourceLat,
            sourceLon: ride.fare.sourceLon,
          },
        });
      }
    }
  }
}
