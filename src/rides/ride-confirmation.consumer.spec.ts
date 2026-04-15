import { Test, TestingModule } from '@nestjs/testing';
import { ClientKafka } from '@nestjs/microservices';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import { DriversService } from '../drivers/drivers.service';
import { KAFKA_CLIENT } from '../kafka/kafka.constants';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { Ride } from './ride.entity';
import { RideConfirmationConsumer } from './ride-confirmation.consumer';
import {
  DRIVER_LOCK_KEY,
  REJECTED_SET_KEY,
  TIMEOUT_HASH_KEY,
} from './matching.consumer';

describe('RideConfirmationConsumer', () => {
  let consumer: RideConfirmationConsumer;
  let rideRepository: jest.Mocked<Partial<Repository<Ride>>>;
  let driversService: jest.Mocked<Partial<DriversService>>;
  let redis: jest.Mocked<Partial<Redis>>;
  let kafkaClient: jest.Mocked<Partial<ClientKafka>>;

  beforeEach(async () => {
    rideRepository = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
    };
    driversService = {
      setAvailability: jest.fn(),
    };
    redis = {
      del: jest.fn(),
      sadd: jest.fn(),
    };
    kafkaClient = {
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RideConfirmationConsumer,
        { provide: getRepositoryToken(Ride), useValue: rideRepository },
        { provide: DriversService, useValue: driversService },
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: KAFKA_CLIENT, useValue: kafkaClient },
      ],
    }).compile();

    consumer = module.get(RideConfirmationConsumer);
  });

  it('confirms a ride on accept and clears coordination keys', async () => {
    const execute = jest.fn().mockResolvedValue({ affected: 1 });
    (rideRepository.createQueryBuilder as jest.Mock).mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute,
    });

    await consumer.handleDriverResponse({
      rideId: 'ride-1',
      driverId: 'driver-1',
      decision: 'accept',
    });

    expect(driversService.setAvailability).toHaveBeenCalledWith(
      'driver-1',
      false,
    );
    expect(redis.del).toHaveBeenCalledWith(DRIVER_LOCK_KEY('driver-1'));
    expect(redis.del).toHaveBeenCalledWith(REJECTED_SET_KEY('ride-1'));
    expect(redis.del).toHaveBeenCalledWith(TIMEOUT_HASH_KEY('ride-1'));
  });

  it('requeues a ride on reject after releasing the lock', async () => {
    const execute = jest.fn().mockResolvedValue({ affected: 1 });
    (rideRepository.createQueryBuilder as jest.Mock).mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute,
    });
    (rideRepository.findOne as jest.Mock).mockResolvedValue({
      id: 'ride-1',
      riderId: 'rider-1',
      source: 'Source',
      destination: 'Destination',
      fare: {
        sourceLat: 19.1,
        sourceLon: 72.8,
      },
    });

    await consumer.handleDriverResponse({
      rideId: 'ride-1',
      driverId: 'driver-1',
      decision: 'reject',
    });

    expect(redis.sadd).toHaveBeenCalledWith(
      REJECTED_SET_KEY('ride-1'),
      'driver-1',
    );
    expect(redis.del).toHaveBeenCalledWith(DRIVER_LOCK_KEY('driver-1'));
    expect(kafkaClient.emit).toHaveBeenCalledWith(expect.any(String), {
      key: 'ride-1',
      value: {
        rideId: 'ride-1',
        riderId: 'rider-1',
        source: 'Source',
        destination: 'Destination',
        sourceLat: 19.1,
        sourceLon: 72.8,
      },
    });
  });

  it('discards stale accept events', async () => {
    const execute = jest.fn().mockResolvedValue({ affected: 0 });
    (rideRepository.createQueryBuilder as jest.Mock).mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute,
    });

    await consumer.handleDriverResponse({
      rideId: 'ride-1',
      driverId: 'driver-1',
      decision: 'accept',
    });

    expect(driversService.setAvailability).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });
});
