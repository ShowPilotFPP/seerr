import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRatingCache1791045629540 implements MigrationInterface {
  name = 'AddRatingCache1791045629540';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "rating" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tmdbId" integer NOT NULL, "mediaType" varchar NOT NULL, "imdbId" varchar, "rtCriticsScore" integer, "rtAudienceScore" integer, "rtCriticsRating" varchar, "rtUrl" varchar, "imdbRating" float, "imdbVoteCount" integer, "lastCheckedAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UNIQUE_RATING_TMDB_MEDIATYPE" UNIQUE ("tmdbId", "mediaType"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d38661f0d3078d7d455c27768f" ON "rating" ("tmdbId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_44cba9f45c49e30bd0d4f3d091" ON "rating" ("rtCriticsScore") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_303002cf7182aad04e7b0e562b" ON "rating" ("rtAudienceScore") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_35515bca3e851478d75a3fd5c8" ON "rating" ("imdbRating") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fdb5bb3d0f6d55091ebd34b177" ON "rating" ("lastCheckedAt") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_fdb5bb3d0f6d55091ebd34b177"`);
    await queryRunner.query(`DROP INDEX "IDX_35515bca3e851478d75a3fd5c8"`);
    await queryRunner.query(`DROP INDEX "IDX_303002cf7182aad04e7b0e562b"`);
    await queryRunner.query(`DROP INDEX "IDX_44cba9f45c49e30bd0d4f3d091"`);
    await queryRunner.query(`DROP INDEX "IDX_d38661f0d3078d7d455c27768f"`);
    await queryRunner.query(`DROP TABLE "rating"`);
  }
}
