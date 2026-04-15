import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthModule } from './health/health.module';
import { DriversModule } from './drivers/drivers.module';
import { FaresModule } from './fares/fares.module';
import { RidesModule } from './rides/rides.module';
import { RedisModule } from './redis/redis.module';
import { Rider } from './riders/rider.entity';
import { Driver } from './drivers/driver.entity';
import { Fare } from './fares/fare.entity';
import { Ride } from './rides/ride.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres' as const,
        host: configService.get<string>('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT', 5432),
        username: configService.get<string>('DB_USER', 'postgres'),
        password: configService.get<string>('DB_PASSWORD', 'postgres'),
        database: configService.get<string>('DB_NAME', 'uber_system'),
        entities: [Rider, Driver, Fare, Ride],
        synchronize: false,
        logging: configService.get<string>('NODE_ENV') === 'development',
      }),
      inject: [ConfigService],
    }),
    HealthModule,
    RedisModule,
    DriversModule,
    FaresModule,
    RidesModule,
  ],
})
export class AppModule {}
