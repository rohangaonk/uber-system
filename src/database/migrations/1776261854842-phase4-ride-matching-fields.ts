import { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase4RideMatchingFields1776261854842 implements MigrationInterface {
  name = 'Phase4RideMatchingFields1776261854842';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "rides" ADD "offered_driver_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "rides" ADD "offer_expires_at" TIMESTAMP WITH TIME ZONE`,
    );
    // Add with a default for existing rows, then drop the default so new rows must supply a value
    await queryRunner.query(
      `ALTER TABLE "rides" ADD "matching_deadline" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()`,
    );
    await queryRunner.query(
      `ALTER TABLE "rides" ALTER COLUMN "matching_deadline" DROP DEFAULT`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rides" DROP COLUMN "matching_deadline"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rides" DROP COLUMN "offer_expires_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rides" DROP COLUMN "offered_driver_id"`,
    );
  }
}
