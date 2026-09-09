import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1788915102995 implements MigrationInterface {
  name = 'CreateVideos1788915102995';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "UQ_5dbcc1ee100f853490582eccc71"`,
    );
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "slug"`);
    await queryRunner.query(
      `ALTER TABLE "videos" DROP COLUMN "duration_seconds"`,
    );
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "error_message"`);
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "unique_id" character varying(20) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "UQ_662303fa603e468e017db540662" UNIQUE ("unique_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "duration" double precision`,
    );
    await queryRunner.query(`ALTER TABLE "videos" ADD "file_size" bigint`);
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "mime_type" character varying(100)`,
    );
    await queryRunner.query(`ALTER TABLE "videos" ADD "processing_error" text`);
    await queryRunner.query(
      `ALTER TYPE "public"."videos_status_enum" RENAME TO "videos_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ALTER COLUMN "status" TYPE "public"."videos_status_enum" USING "status"::"text"::"public"."videos_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ALTER COLUMN "status" SET DEFAULT 'draft'`,
    );
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum_old"`);
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "storage_key"`);
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "storage_key" character varying(500)`,
    );
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "thumbnail_key"`);
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "thumbnail_key" character varying(500)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "thumbnail_key"`);
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "thumbnail_key" character varying(512)`,
    );
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "storage_key"`);
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "storage_key" character varying(512)`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum_old" AS ENUM('draft', 'pending_processing', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ALTER COLUMN "status" TYPE "public"."videos_status_enum_old" USING "status"::"text"::"public"."videos_status_enum_old"`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ALTER COLUMN "status" SET DEFAULT 'draft'`,
    );
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."videos_status_enum_old" RENAME TO "videos_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" DROP COLUMN "processing_error"`,
    );
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "mime_type"`);
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "file_size"`);
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "duration"`);
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "UQ_662303fa603e468e017db540662"`,
    );
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "unique_id"`);
    await queryRunner.query(`ALTER TABLE "videos" ADD "error_message" text`);
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "duration_seconds" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "slug" character varying(20) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "UQ_5dbcc1ee100f853490582eccc71" UNIQUE ("slug")`,
    );
  }
}
