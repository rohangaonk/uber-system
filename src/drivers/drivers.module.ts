import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Driver } from './driver.entity';
import { DriversController } from './drivers.controller';
import { DriversCleanupService } from './drivers.cleanup.service';
import { DriversService } from './drivers.service';

@Module({
  imports: [TypeOrmModule.forFeature([Driver]), ScheduleModule.forRoot()],
  controllers: [DriversController],
  providers: [DriversService, DriversCleanupService],
  exports: [DriversService],
})
export class DriversModule {}
