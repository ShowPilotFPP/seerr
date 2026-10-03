import type { MediaType } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Local cache of third-party ratings (Rotten Tomatoes, IMDb) keyed by TMDB ID.
 *
 * TMDB's discover API knows nothing about RT/IMDb scores, so to filter
 * Discover results by them we need the scores stored locally. Rows are
 * written whenever ratings are fetched (details pages, background job) and
 * refreshed periodically using `lastCheckedAt`.
 *
 * Every score is nullable: null means "no score exists / not found", which
 * is different from "never checked" (no row at all).
 */
@Entity()
@Unique('UNIQUE_RATING_TMDB_MEDIATYPE', ['tmdbId', 'mediaType'])
export class Rating {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  @Index()
  public tmdbId: number;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @Column({ type: 'varchar', nullable: true })
  public imdbId?: string | null;

  // Rotten Tomatoes Tomatometer (critics), 0-100
  @Column({ type: 'integer', nullable: true })
  @Index()
  public rtCriticsScore?: number | null;

  // Rotten Tomatoes Popcornmeter (audience), 0-100
  @Column({ type: 'integer', nullable: true })
  @Index()
  public rtAudienceScore?: number | null;

  // 'Certified Fresh' | 'Fresh' | 'Rotten'
  @Column({ type: 'varchar', nullable: true })
  public rtCriticsRating?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public rtUrl?: string | null;

  // IMDb user rating, 0.0-10.0
  @Column({ type: 'float', nullable: true })
  @Index()
  public imdbRating?: number | null;

  @Column({ type: 'integer', nullable: true })
  public imdbVoteCount?: number | null;

  // When we last asked RT/IMDb for this title (drives refreshes)
  @DbAwareColumn({ type: 'datetime' })
  @Index()
  public lastCheckedAt: Date;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<Rating>) {
    Object.assign(this, init);
  }
}

export default Rating;
