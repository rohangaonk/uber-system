import * as dotenv from 'dotenv';
dotenv.config();

import { DataSource } from 'typeorm';
import { Rider } from '../riders/rider.entity';
import { Driver } from '../drivers/driver.entity';
import { Fare } from '../fares/fare.entity';
import { Ride } from '../rides/ride.entity';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME ?? 'uber_system',
  entities: [Rider, Driver, Fare, Ride],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
});
