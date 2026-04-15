import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { DriversService } from './drivers.service';
import { UpdateLocationDto } from './dto/update-location.dto';

@Controller('drivers')
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Post('location')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateLocation(@Body() dto: UpdateLocationDto): Promise<void> {
    await this.driversService.updateLocation(dto.driverId, dto.lat, dto.lon);
  }
}
