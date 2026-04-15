import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Rider } from '../riders/rider.entity';

@Entity('fares')
export class Fare {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Rider)
  @JoinColumn({ name: 'rider_id' })
  rider: Rider;

  @Column({ name: 'rider_id' })
  riderId: string;

  @Column({ length: 500 })
  source: string;

  @Column({ length: 500 })
  destination: string;

  @Column({ name: 'source_lat', type: 'double precision' })
  sourceLat: number;

  @Column({ name: 'source_lon', type: 'double precision' })
  sourceLon: number;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  price: number;

  @Column({ name: 'eta_minutes' })
  etaMinutes: number;

  @Index()
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
