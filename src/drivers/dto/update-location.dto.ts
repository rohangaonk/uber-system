import { IsNumber, IsUUID, Max, Min } from 'class-validator';

export class UpdateLocationDto {
  @IsUUID()
  driverId: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lon: number;
}
