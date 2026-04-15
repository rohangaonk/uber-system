import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { RidesService } from './rides.service';
import { CreateRideDto } from './dto/create-ride.dto';

@Controller('rides')
export class RidesController {
  constructor(private readonly ridesService: RidesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  createRide(@Body() dto: CreateRideDto) {
    return this.ridesService.createRide(dto);
  }

  @Get(':rideId/status')
  getRideStatus(@Param('rideId', ParseUUIDPipe) rideId: string) {
    return this.ridesService.getRideStatus(rideId);
  }
}
