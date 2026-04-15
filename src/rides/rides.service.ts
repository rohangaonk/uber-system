import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientKafka } from '@nestjs/microservices';
import { In, Repository } from 'typeorm';
import { Ride } from './ride.entity';
import { RideStatus } from './ride-status.enum';
import { FaresService } from '../fares/fares.service';
import { CreateRideDto } from './dto/create-ride.dto';
import { KAFKA_CLIENT, KAFKA_TOPICS } from '../kafka/kafka.constants';

const MATCHING_DEADLINE_SECONDS = 60;

@Injectable()
export class RidesService {
  constructor(
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    private readonly faresService: FaresService,
    @Inject(KAFKA_CLIENT)
    private readonly kafkaClient: ClientKafka,
  ) {}

  async createRide(dto: CreateRideDto): Promise<{ rideId: string; status: RideStatus }> {
    // 1. Fetch fare or 404
    const fare = await this.faresService.findById(dto.fareId);
    if (!fare) {
      throw new NotFoundException(`Fare ${dto.fareId} not found`);
    }

    // 2. Ownership check
    if (fare.riderId !== dto.riderId) {
      throw new ForbiddenException('This fare does not belong to the requesting rider');
    }

    // 3. Expiry check
    if (fare.expiresAt < new Date()) {
      throw new BadRequestException('FARE_EXPIRED: This fare has expired. Please request a new one.');
    }

    // 4. One-active-ride invariant
    const activeStatuses = [
      RideStatus.RIDE_REQUESTED,
      RideStatus.MATCHING,
      RideStatus.DRIVER_OFFERED,
    ];
    const existingRide = await this.rideRepository.findOne({
      where: { riderId: dto.riderId, status: In(activeStatuses) },
    });
    if (existingRide) {
      throw new ConflictException(
        `Rider already has an active ride (${existingRide.id}). Cancel it before requesting a new one.`,
      );
    }

    // 5. Create ride with matching deadline
    const matchingDeadline = new Date(Date.now() + MATCHING_DEADLINE_SECONDS * 1000);
    const ride = this.rideRepository.create({
      fareId: dto.fareId,
      riderId: dto.riderId,
      source: fare.source,
      destination: fare.destination,
      status: RideStatus.RIDE_REQUESTED,
      matchingDeadline,
      offeredDriverId: null,
      offerExpiresAt: null,
    });

    const saved = await this.rideRepository.save(ride);

    // 6. Publish ride.requested — matching consumer picks this up asynchronously
    this.kafkaClient.emit(KAFKA_TOPICS.RIDE_REQUESTED, {
      key: saved.id,
      value: {
        rideId: saved.id,
        riderId: saved.riderId,
        source: saved.source,
        destination: saved.destination,
        sourceLat: fare.sourceLat,
        sourceLon: fare.sourceLon,
      },
    });

    return { rideId: saved.id, status: saved.status };
  }

  async getRideStatus(rideId: string): Promise<{
    rideId: string;
    status: RideStatus;
    driver: { name: string; phone: string } | null;
  }> {
    const ride = await this.rideRepository.findOne({
      where: { id: rideId },
      relations: ['driver'],
    });

    if (!ride) {
      throw new NotFoundException(`Ride ${rideId} not found`);
    }

    return {
      rideId: ride.id,
      status: ride.status,
      driver: ride.driver
        ? { name: ride.driver.name, phone: ride.driver.phone }
        : null,
    };
  }

  // Used by the matching consumer to load the ride row
  async findById(rideId: string): Promise<Ride | null> {
    return this.rideRepository.findOne({ where: { id: rideId } });
  }

  // Conditional status update — returns true if the update won the race
  async transitionStatus(
    rideId: string,
    fromStatus: RideStatus,
    toStatus: RideStatus,
    extra: Partial<Ride> = {},
  ): Promise<boolean> {
    const result = await this.rideRepository
      .createQueryBuilder()
      .update(Ride)
      .set({ status: toStatus, ...extra })
      .where('id = :rideId AND status = :fromStatus', { rideId, fromStatus })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async driverRespond(
    rideId: string,
    driverId: string,
    decision: 'accept' | 'reject',
  ): Promise<void> {
    const ride = await this.rideRepository.findOne({ where: { id: rideId } });

    if (!ride) throw new NotFoundException(`Ride ${rideId} not found`);

    if (ride.status !== RideStatus.DRIVER_OFFERED) {
      throw new GoneException('This offer is no longer active');
    }

    if (ride.offeredDriverId !== driverId) {
      throw new GoneException('You are not the driver currently offered this ride');
    }

    if (!ride.offerExpiresAt || ride.offerExpiresAt < new Date()) {
      throw new GoneException('This offer has expired');
    }

    this.kafkaClient.emit(KAFKA_TOPICS.DRIVER_RESPONSE, {
      key: rideId,
      value: { rideId, driverId, decision },
    });
  }
}
