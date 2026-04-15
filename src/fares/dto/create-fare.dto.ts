import { IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateFareDto {
  @IsUUID()
  riderId: string;

  @IsString()
  @MaxLength(500)
  source: string;

  @IsString()
  @MaxLength(500)
  destination: string;
}
