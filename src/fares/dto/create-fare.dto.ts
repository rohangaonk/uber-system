import {
  IsNumber,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateFareDto {
  @IsUUID()
  riderId: string;

  @IsString()
  @MaxLength(500)
  source: string;

  @IsString()
  @MaxLength(500)
  destination: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  sourceLat: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  sourceLon: number;
}
