import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1788915102995 implements MigrationInterface {
  name = 'CreateVideos1788915102995';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "channel_id" uuid NOT NULL,
        "title" character varying(255) NOT NULL,
        "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft',
        "unique_id" character varying(20) NOT NULL,
        "storage_key" character varying(500),
        "thumbnail_key" character varying(500),
        "duration" double precision,
        "file_size" bigint,
        "mime_type" character varying(100),
        "metadata" jsonb,
        "processing_error" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_662303fa603e468e017db540662" UNIQUE ("unique_id"),
        CONSTRAINT "PK_videos" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_videos_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_videos_channel_id"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
