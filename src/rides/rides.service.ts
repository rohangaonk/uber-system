import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Ride } from './ride.entity';
import { RideStatus } from './ride-status.enum';
import { FaresService } from '../fares/fares.service';
import { CreateRideDto } from './dto/create-ride.dto';

@Injectable()
export class RidesService {
  constructor(
    @InjectRepository(Ride)
    private readonly rideRepository: Repository<Ride>,
    private readonly faresService: FaresService,
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
      where: {
        riderId: dto.riderId,
        status: In(activeStatuses),
      },
    });
    if (existingRide) {
      throw new ConflictException(
        `Rider already has an active ride (${existingRide.id}). Cancel it before requesting a new one.`,
      );
    }

    // 5. Create ride — copy source/destination from fare
    const ride = this.rideRepository.create({
      fareId: dto.fareId,
      riderId: dto.riderId,
      source: fare.source,
      destination: fare.destination,
      status: RideStatus.RIDE_REQUESTED,
    });

    const saved = await this.rideRepository.save(ride);

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
}
