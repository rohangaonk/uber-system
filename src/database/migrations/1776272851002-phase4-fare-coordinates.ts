import { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase4FareCoordinates1776272851002 implements MigrationInterface {
  name = 'Phase4FareCoordinates1776272851002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "fares" ADD "source_lat" double precision NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "fares" ALTER COLUMN "source_lat" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "fares" ADD "source_lon" double precision NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "fares" ALTER COLUMN "source_lon" DROP DEFAULT`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "fares" DROP COLUMN "source_lon"`);
    await queryRunner.query(`ALTER TABLE "fares" DROP COLUMN "source_lat"`);
  }
}
