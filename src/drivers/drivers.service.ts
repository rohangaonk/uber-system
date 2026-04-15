import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import Redis from 'ioredis';
import { Driver } from './driver.entity';
import { REDIS_CLIENT } from '../redis/redis.constants';

export const GEO_KEY = 'driver:locations';
export const LAST_SEEN_KEY = 'driver:last_seen';

export interface NearbyDriver {
  driverId: string;
  distanceKm: number;
}

@Injectable()
export class DriversService {
  constructor(
    @InjectRepository(Driver)
    private readonly driverRepository: Repository<Driver>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async updateLocation(
    driverId: string,
    lat: number,
    lon: number,
  ): Promise<void> {
    const exists = await this.driverRepository.existsBy({ id: driverId });
    if (!exists) throw new NotFoundException(`Driver ${driverId} not found`);

    await Promise.all([
      this.redis.geoadd(GEO_KEY, lon, lat, driverId),
      this.redis.zadd(LAST_SEEN_KEY, Date.now(), driverId),
    ]);
  }

  // Used by the matching engine in Phase 4.
  // Returns available drivers sorted by distance ascending.
  async findNearby(
    lat: number,
    lon: number,
    radiusKm = 5,
  ): Promise<NearbyDriver[]> {
    const raw = (await this.redis.call(
      'GEOSEARCH',
      GEO_KEY,
      'FROMLONLAT',
      String(lon),
      String(lat),
      'BYRADIUS',
      String(radiusKm),
      'km',
      'ASC',
      'COUNT',
      '20',
      'WITHDIST',
    )) as Array<[string, string]>;

    if (!raw || raw.length === 0) return [];

    const driverIds = raw.map(([id]) => id);

    const available = await this.driverRepository.find({
      where: { id: In(driverIds), isAvailable: true },
      select: ['id'],
    });
    const availableSet = new Set(available.map((d) => d.id));

    return raw
      .filter(([id]) => availableSet.has(id))
      .map(([id, dist]) => ({ driverId: id, distanceKm: parseFloat(dist) }));
  }

  async setAvailability(driverId: string, isAvailable: boolean): Promise<void> {
    await this.driverRepository.update(driverId, { isAvailable });
  }
}
