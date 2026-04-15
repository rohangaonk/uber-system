import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Ride } from './ride.entity';
import { RidesController } from './rides.controller';
import { RidesService } from './rides.service';
import { MatchingConsumer } from './matching.consumer';
import { RideConfirmationConsumer } from './ride-confirmation.consumer';
import { OfferTimeoutService } from './offer-timeout.service';
import { FaresModule } from '../fares/fares.module';
import { DriversModule } from '../drivers/drivers.module';
import { KAFKA_CLIENT, KAFKA_CONSUMER_GROUPS } from '../kafka/kafka.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ride]),
    FaresModule,
    DriversModule,
    ClientsModule.registerAsync([
      {
        name: KAFKA_CLIENT,
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.KAFKA,
          options: {
            client: {
              clientId: 'rides-producer',
              brokers: [
                configService.get<string>('KAFKA_BROKER', 'localhost:9092'),
              ],
            },
            consumer: { groupId: KAFKA_CONSUMER_GROUPS.MATCHING_WORKERS },
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [RidesController, MatchingConsumer, RideConfirmationConsumer],
  providers: [RidesService, OfferTimeoutService],
  exports: [RidesService],
})
export class RidesModule {}
