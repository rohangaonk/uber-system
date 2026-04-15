import { MigrationInterface, QueryRunner } from "typeorm";

export class Migration1776170691740 implements MigrationInterface {
    name = 'Migration1776170691740'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "riders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL, "email" character varying(150) NOT NULL, "phone" character varying(20) NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_ed6e8eb2542a3c7c1742f9c2b54" UNIQUE ("email"), CONSTRAINT "PK_6c17e67f760677500c29d68e689" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "drivers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(100) NOT NULL, "email" character varying(150) NOT NULL, "phone" character varying(20) NOT NULL, "is_available" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_d4cfc1aafe3a14622aee390edb2" UNIQUE ("email"), CONSTRAINT "PK_92ab3fb69e566d3eb0cae896047" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_16c383c710d73e960022da87ff" ON "drivers" ("is_available") `);
        await queryRunner.query(`CREATE TABLE "fares" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "rider_id" uuid NOT NULL, "source" character varying(500) NOT NULL, "destination" character varying(500) NOT NULL, "price" numeric(10,2) NOT NULL, "eta_minutes" integer NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_01e9e567db5766e439be822b3d1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4b4d3807ea8896fc748b9bd473" ON "fares" ("expires_at") `);
        await queryRunner.query(`CREATE TYPE "public"."rides_status_enum" AS ENUM('ride_requested', 'matching', 'driver_offered', 'confirmed', 'no_driver_found', 'cancelled')`);
        await queryRunner.query(`CREATE TABLE "rides" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "fare_id" uuid NOT NULL, "rider_id" uuid NOT NULL, "driver_id" uuid, "status" "public"."rides_status_enum" NOT NULL DEFAULT 'ride_requested', "source" character varying(500) NOT NULL, "destination" character varying(500) NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_dc825d8e932bb18213cf43b0542" UNIQUE ("fare_id"), CONSTRAINT "PK_ca6f62fc1e999b139c7f28f07fd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_87b9253c85be51e3785d3653a8" ON "rides" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_575eaa9b00793e81f12cf5c4ef" ON "rides" ("rider_id", "status") `);
        await queryRunner.query(`ALTER TABLE "fares" ADD CONSTRAINT "FK_c8448cfbe711352ed06b9b73083" FOREIGN KEY ("rider_id") REFERENCES "riders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "rides" ADD CONSTRAINT "FK_dc825d8e932bb18213cf43b0542" FOREIGN KEY ("fare_id") REFERENCES "fares"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "rides" ADD CONSTRAINT "FK_d8ca08acdee36ad9774cbf1c57a" FOREIGN KEY ("rider_id") REFERENCES "riders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "rides" ADD CONSTRAINT "FK_fb13184768dea9734b022874c6f" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "rides" DROP CONSTRAINT "FK_fb13184768dea9734b022874c6f"`);
        await queryRunner.query(`ALTER TABLE "rides" DROP CONSTRAINT "FK_d8ca08acdee36ad9774cbf1c57a"`);
        await queryRunner.query(`ALTER TABLE "rides" DROP CONSTRAINT "FK_dc825d8e932bb18213cf43b0542"`);
        await queryRunner.query(`ALTER TABLE "fares" DROP CONSTRAINT "FK_c8448cfbe711352ed06b9b73083"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_575eaa9b00793e81f12cf5c4ef"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_87b9253c85be51e3785d3653a8"`);
        await queryRunner.query(`DROP TABLE "rides"`);
        await queryRunner.query(`DROP TYPE "public"."rides_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4b4d3807ea8896fc748b9bd473"`);
        await queryRunner.query(`DROP TABLE "fares"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_16c383c710d73e960022da87ff"`);
        await queryRunner.query(`DROP TABLE "drivers"`);
        await queryRunner.query(`DROP TABLE "riders"`);
    }

}
