import { IsUUID } from 'class-validator';

export class CreateRideDto {
  @IsUUID()
  fareId: string;

  @IsUUID()
  riderId: string;
}
