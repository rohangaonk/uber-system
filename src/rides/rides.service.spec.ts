import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FaresService } from '../fares/fares.service';
import { Driver } from '../drivers/driver.entity';
import { KAFKA_CLIENT, KAFKA_TOPICS } from '../kafka/kafka.constants';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { Ride } from './ride.entity';
import { RideStatus } from './ride-status.enum';
import { RidesService } from './rides.service';
import {
  DRIVER_LOCK_KEY,
  REJECTED_SET_KEY,
  TIMEOUT_HASH_KEY,
} from './matching.consumer';

type RideTxRepository = {
  findOne: (options: Record<string, unknown>) => Promise<Ride | null>;
  update: (
    criteria: Record<string, unknown>,
    partial: Record<string, unknown>,
  ) => Promise<{ affected?: number }>;
};

type DriverTxRepository = {
  update: (
    driverId: string,
    partial: Record<string, unknown>,
  ) => Promise<{ affected?: number }>;
};

type TransactionManager = {
  getRepository(
    entity: typeof Ride | typeof Driver,
  ): RideTxRepository | DriverTxRepository;
};

type TransactionCallback = (manager: TransactionManager) => Promise<unknown>;

type CancelRideFn = (rideId: string) => Promise<void>;

describe('RidesService', () => {
  let service: RidesService;
  let rideRepository: jest.Mocked<Partial<Repository<Ride>>>;
  let faresService: jest.Mocked<Partial<FaresService>>;
  let kafkaClient: jest.Mocked<Partial<ClientKafka>>;
  let redis: jest.Mocked<Partial<{ del: jest.Mock }>>;
  let transactionMock: jest.Mock;

  beforeEach(async () => {
    transactionMock = jest.fn();
    rideRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      createQueryBuilder: jest.fn(),
      manager: {
        transaction: transactionMock,
      },
    } as unknown as jest.Mocked<Partial<Repository<Ride>>>;
    faresService = {
      findById: jest.fn(),
    };
    kafkaClient = {
      emit: jest.fn(),
    };
    redis = {
      del: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RidesService,
        { provide: getRepositoryToken(Ride), useValue: rideRepository },
        { provide: FaresService, useValue: faresService },
        { provide: KAFKA_CLIENT, useValue: kafkaClient },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    service = module.get<RidesService>(RidesService);
  });

  describe('driverRespond', () => {
    it('publishes driver.response for an active matching driver', async () => {
      const now = new Date();
      (rideRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'ride-1',
        status: RideStatus.DRIVER_OFFERED,
        offeredDriverId: 'driver-1',
        offerExpiresAt: new Date(now.getTime() + 60_000),
      });

      await service.driverRespond('ride-1', 'driver-1', 'accept');

      expect(kafkaClient.emit).toHaveBeenCalledWith(
        KAFKA_TOPICS.DRIVER_RESPONSE,
        {
          key: 'ride-1',
          value: {
            rideId: 'ride-1',
            driverId: 'driver-1',
            decision: 'accept',
          },
        },
      );
    });

    it.each([
      {
        name: 'missing ride',
        ride: null,
        error: NotFoundException,
      },
      {
        name: 'wrong ride status',
        ride: {
          id: 'ride-1',
          status: RideStatus.RIDE_REQUESTED,
          offeredDriverId: 'driver-1',
          offerExpiresAt: new Date(Date.now() + 60_000),
        },
        error: GoneException,
      },
      {
        name: 'wrong driver',
        ride: {
          id: 'ride-1',
          status: RideStatus.DRIVER_OFFERED,
          offeredDriverId: 'driver-2',
          offerExpiresAt: new Date(Date.now() + 60_000),
        },
        error: GoneException,
      },
      {
        name: 'expired offer',
        ride: {
          id: 'ride-1',
          status: RideStatus.DRIVER_OFFERED,
          offeredDriverId: 'driver-1',
          offerExpiresAt: new Date(Date.now() - 60_000),
        },
        error: GoneException,
      },
    ])('rejects $name', async ({ ride, error }) => {
      (rideRepository.findOne as jest.Mock).mockResolvedValue(ride);

      await expect(
        service.driverRespond('ride-1', 'driver-1', 'reject'),
      ).rejects.toBeInstanceOf(error);
      expect(kafkaClient.emit).not.toHaveBeenCalled();
    });
  });

  describe('createRide', () => {
    it('rejects expired fares before emitting matching work', async () => {
      (faresService.findById as jest.Mock).mockResolvedValue({
        id: 'fare-1',
        riderId: 'rider-1',
        expiresAt: new Date(Date.now() - 1_000),
      });

      await expect(
        service.createRide({ fareId: 'fare-1', riderId: 'rider-1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(kafkaClient.emit).not.toHaveBeenCalled();
    });

    it('enforces one active ride per rider', async () => {
      (faresService.findById as jest.Mock).mockResolvedValue({
        id: 'fare-1',
        riderId: 'rider-1',
        source: 'A',
        destination: 'B',
        sourceLat: 1,
        sourceLon: 2,
        expiresAt: new Date(Date.now() + 60_000),
      });
      (rideRepository.findOne as jest.Mock).mockResolvedValue({ id: 'ride-1' });

      await expect(
        service.createRide({ fareId: 'fare-1', riderId: 'rider-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(kafkaClient.emit).not.toHaveBeenCalled();
    });

    it('rejects fares owned by a different rider', async () => {
      (faresService.findById as jest.Mock).mockResolvedValue({
        id: 'fare-1',
        riderId: 'rider-2',
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        service.createRide({ fareId: 'fare-1', riderId: 'rider-1' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('cancelRide', () => {
    it('cancels a ride-requested ride without touching driver locks', async () => {
      const rideFindOneMock = jest.fn();
      const rideUpdateMock = jest.fn();
      const driverUpdateMock = jest.fn();

      rideFindOneMock.mockResolvedValue({
        id: 'ride-1',
        status: RideStatus.RIDE_REQUESTED,
        offeredDriverId: null,
      });
      rideUpdateMock.mockResolvedValue({ affected: 1 });
      driverUpdateMock.mockResolvedValue({ affected: 1 });

      const rideTxRepository: RideTxRepository = {
        findOne: rideFindOneMock,
        update: rideUpdateMock,
      };
      const driverTxRepository: DriverTxRepository = {
        update: driverUpdateMock,
      };
      const manager: TransactionManager = {
        getRepository: (entity) =>
          entity === Ride ? rideTxRepository : driverTxRepository,
      };

      transactionMock.mockImplementation((callback: TransactionCallback) =>
        callback(manager),
      );

      const cancelRide = service.cancelRide.bind(service) as CancelRideFn;
      await cancelRide('ride-1');

      expect(rideFindOneMock).toHaveBeenCalledWith({
        where: { id: 'ride-1' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(rideUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ride-1' }),
        {
          status: RideStatus.CANCELLED,
          offeredDriverId: null,
          offerExpiresAt: null,
        },
      );
      expect(driverUpdateMock).not.toHaveBeenCalled();
      expect(redis.del).toHaveBeenCalledWith(REJECTED_SET_KEY('ride-1'));
      expect(redis.del).toHaveBeenCalledWith(TIMEOUT_HASH_KEY('ride-1'));
      expect(redis.del).not.toHaveBeenCalledWith(DRIVER_LOCK_KEY('driver-1'));
    });

    it('releases the driver lock and restores availability when cancelling an offered ride', async () => {
      const rideFindOneMock = jest.fn();
      const rideUpdateMock = jest.fn();
      const driverUpdateMock = jest.fn();

      rideFindOneMock.mockResolvedValue({
        id: 'ride-1',
        status: RideStatus.DRIVER_OFFERED,
        offeredDriverId: 'driver-1',
      });
      rideUpdateMock.mockResolvedValue({ affected: 1 });
      driverUpdateMock.mockResolvedValue({ affected: 1 });

      const rideTxRepository: RideTxRepository = {
        findOne: rideFindOneMock,
        update: rideUpdateMock,
      };
      const driverTxRepository: DriverTxRepository = {
        update: driverUpdateMock,
      };
      const manager: TransactionManager = {
        getRepository: (entity) =>
          entity === Ride ? rideTxRepository : driverTxRepository,
      };

      transactionMock.mockImplementation((callback: TransactionCallback) =>
        callback(manager),
      );

      const cancelRide = service.cancelRide.bind(service) as CancelRideFn;
      await cancelRide('ride-1');

      expect(driverUpdateMock).toHaveBeenCalledWith('driver-1', {
        isAvailable: true,
      });
      expect(redis.del).toHaveBeenCalledWith(DRIVER_LOCK_KEY('driver-1'));
      expect(redis.del).toHaveBeenCalledWith(REJECTED_SET_KEY('ride-1'));
      expect(redis.del).toHaveBeenCalledWith(TIMEOUT_HASH_KEY('ride-1'));
    });

    it('rejects cancellation after the ride is already confirmed', async () => {
      const rideFindOneMock = jest.fn();
      const rideUpdateMock = jest.fn();
      const driverUpdateMock = jest.fn();

      rideFindOneMock.mockResolvedValue({
        id: 'ride-1',
        status: RideStatus.CONFIRMED,
      });
      rideUpdateMock.mockResolvedValue({ affected: 1 });
      driverUpdateMock.mockResolvedValue({ affected: 1 });

      const rideTxRepository: RideTxRepository = {
        findOne: rideFindOneMock,
        update: rideUpdateMock,
      };
      const driverTxRepository: DriverTxRepository = {
        update: driverUpdateMock,
      };
      const manager: TransactionManager = {
        getRepository: (entity) =>
          entity === Ride ? rideTxRepository : driverTxRepository,
      };

      transactionMock.mockImplementation((callback: TransactionCallback) =>
        callback(manager),
      );

      const cancelRide = service.cancelRide.bind(service) as CancelRideFn;
      await expect(cancelRide('ride-1')).rejects.toBeInstanceOf(GoneException);
      expect(redis.del).not.toHaveBeenCalled();
    });
  });
});
