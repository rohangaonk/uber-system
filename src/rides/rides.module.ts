import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ride } from './ride.entity';
import { RidesController } from './rides.controller';
import { RidesService } from './rides.service';
import { FaresModule } from '../fares/fares.module';

@Module({
  imports: [TypeOrmModule.forFeature([Ride]), FaresModule],
  controllers: [RidesController],
  providers: [RidesService],
  exports: [RidesService],
})
export class RidesModule {}
