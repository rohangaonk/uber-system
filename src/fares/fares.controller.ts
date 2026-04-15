import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { FaresService } from './fares.service';
import { CreateFareDto } from './dto/create-fare.dto';

@Controller('fares')
export class FaresController {
  constructor(private readonly faresService: FaresService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  createFare(@Body() dto: CreateFareDto) {
    return this.faresService.createFare(dto);
  }
}
