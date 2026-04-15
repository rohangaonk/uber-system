import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { RidesService } from './rides.service';
import { CreateRideDto } from './dto/create-ride.dto';
import { DriverRespondDto } from './dto/driver-respond.dto';

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

  @Patch(':rideId')
  @HttpCode(HttpStatus.NO_CONTENT)
  driverRespond(
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body() dto: DriverRespondDto,
  ) {
    return this.ridesService.driverRespond(rideId, dto.driverId, dto.decision);
  }
}
