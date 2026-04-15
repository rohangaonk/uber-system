/**
 * Seed script: inserts 10 mock drivers into Postgres and registers their
 * locations in Redis.
 *
 * Usage: npx ts-node -r tsconfig-paths/register src/database/seed.ts
 */
import 'reflect-metadata';
import Redis from 'ioredis';
import { AppDataSource } from './data-source';
import { Driver } from '../drivers/driver.entity';
import { GEO_KEY, LAST_SEEN_KEY } from '../drivers/drivers.service';

// Cluster around Mumbai: 19.076, 72.877
const BASE_LAT = 19.076;
const BASE_LON = 72.877;

const MOCK_DRIVERS = Array.from({ length: 10 }, (_, i) => ({
  name: `Driver ${i + 1}`,
  email: `driver${i + 1}@mock.local`,
  phone: `+9198765432${String(i).padStart(2, '0')}`,
  isAvailable: true,
  // Spread ~0–2 km around the base coordinate
  lat: BASE_LAT + (Math.random() - 0.5) * 0.036,
  lon: BASE_LON + (Math.random() - 0.5) * 0.036,
}));

async function seed() {
  await AppDataSource.initialize();
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: 6379,
  });

  const driverRepo = AppDataSource.getRepository(Driver);

  console.log('Seeding drivers...');
  for (const mock of MOCK_DRIVERS) {
    const existing = await driverRepo.findOneBy({ email: mock.email });
    let driver: Driver;

    if (existing) {
      driver = existing;
      console.log(`  Skipped (already exists): ${mock.email}`);
    } else {
      driver = driverRepo.create({
        name: mock.name,
        email: mock.email,
        phone: mock.phone,
        isAvailable: mock.isAvailable,
      });
      driver = await driverRepo.save(driver);
      console.log(`  Created: ${mock.email} (${driver.id})`);
    }

    await redis.geoadd(GEO_KEY, mock.lon, mock.lat, driver.id);
    await redis.zadd(LAST_SEEN_KEY, Date.now(), driver.id);
    console.log(
      `  Location set: lat=${mock.lat.toFixed(5)}, lon=${mock.lon.toFixed(5)}`,
    );
  }

  await AppDataSource.destroy();
  redis.disconnect();
  console.log('\nSeed complete.');
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
