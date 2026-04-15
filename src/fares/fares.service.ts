import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Fare } from './fare.entity';
import { CreateFareDto } from './dto/create-fare.dto';

@Injectable()
export class FaresService {
  constructor(
    @InjectRepository(Fare)
    private readonly fareRepository: Repository<Fare>,
  ) {}

  async createFare(dto: CreateFareDto): Promise<{
    fareId: string;
    price: number;
    etaMinutes: number;
    expiresAt: Date;
  }> {
    // Internal pricing stub — replace with real Maps API in Phase 9
    const distanceKm = Math.floor(Math.random() * 30) + 1; // 1–30 km
    const price = parseFloat((50 + distanceKm * 10).toFixed(2));
    const etaMinutes = distanceKm * 2;

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    const fare = this.fareRepository.create({
      riderId: dto.riderId,
      source: dto.source,
      destination: dto.destination,
      sourceLat: dto.sourceLat,
      sourceLon: dto.sourceLon,
      price,
      etaMinutes,
      expiresAt,
    });

    const saved = await this.fareRepository.save(fare);

    return {
      fareId: saved.id,
      price: saved.price,
      etaMinutes: saved.etaMinutes,
      expiresAt: saved.expiresAt,
    };
  }

  async findById(fareId: string): Promise<Fare | null> {
    return this.fareRepository.findOne({ where: { id: fareId } });
  }
}
