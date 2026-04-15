import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { RideStatus } from './ride-status.enum';
import { Rider } from '../riders/rider.entity';
import { Driver } from '../drivers/driver.entity';
import { Fare } from '../fares/fare.entity';

@Entity('rides')
@Index(['riderId', 'status'])
export class Ride {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Fare)
  @JoinColumn({ name: 'fare_id' })
  fare: Fare;

  @Column({ name: 'fare_id', unique: true })
  fareId: string;

  @ManyToOne(() => Rider)
  @JoinColumn({ name: 'rider_id' })
  rider: Rider;

  @Column({ name: 'rider_id' })
  riderId: string;

  @ManyToOne(() => Driver, { nullable: true })
  @JoinColumn({ name: 'driver_id' })
  driver: Driver | null;

  @Column({ name: 'driver_id', nullable: true, type: 'uuid' })
  driverId: string | null;

  @Index()
  @Column({
    type: 'enum',
    enum: RideStatus,
    default: RideStatus.RIDE_REQUESTED,
  })
  status: RideStatus;

  @Column({ name: 'offered_driver_id', nullable: true, type: 'uuid' })
  offeredDriverId: string | null;

  @Column({ name: 'offer_expires_at', nullable: true, type: 'timestamptz' })
  offerExpiresAt: Date | null;

  @Column({ name: 'matching_deadline', type: 'timestamptz' })
  matchingDeadline: Date;

  @Column({ length: 500 })
  source: string;

  @Column({ length: 500 })
  destination: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
