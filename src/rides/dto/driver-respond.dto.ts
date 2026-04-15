import { IsIn, IsUUID } from 'class-validator';

export class DriverRespondDto {
  @IsUUID()
  driverId: string;

  @IsIn(['accept', 'reject'])
  decision: 'accept' | 'reject';
}
