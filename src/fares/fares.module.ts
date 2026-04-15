import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Fare } from './fare.entity';
import { FaresController } from './fares.controller';
import { FaresService } from './fares.service';

@Module({
  imports: [TypeOrmModule.forFeature([Fare])],
  controllers: [FaresController],
  providers: [FaresService],
  exports: [FaresService],
})
export class FaresModule {}
