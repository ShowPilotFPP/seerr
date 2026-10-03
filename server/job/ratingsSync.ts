import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  fetchAndSaveRatings,
  getCachedRatings,
  isRatingStale,
} from '@server/lib/ratingCache';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import logger from '@server/logger';

/** Pause between titles so we stay polite to RT/IMDb/TMDB. */
const DELAY_MS = 400;

/** How many TMDB discover pages (20 titles each) to pull per list. */
const DISCOVER_PAGES = 10;

/** Discover lists to pre-fill: what's popular now, and well-known titles. */
const DISCOVER_SORTS = ['popularity.desc', 'vote_count.desc'] as const;

interface Target {
  tmdbId: number;
  mediaType: MediaType;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fills the rating cache in the background so Discover can filter by
 * Rotten Tomatoes / IMDb without waiting on lookups.
 *
 * Covers: everything Seerr already tracks (library + requests), plus the
 * top pages of TMDB's popular and most-voted movies and shows. Titles whose
 * cached ratings are still fresh are skipped.
 */
class RatingsSync implements RunnableScanner<StatusBase> {
  private running = false;
  private progress = 0;
  private total = 0;

  public async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const targets = await this.collectTargets();
      const todo = await this.filterStale(targets);
      this.total = todo.length;

      logger.info(
        `Ratings sync: ${todo.length} of ${targets.length} titles need ratings`,
        { label: 'Jobs' }
      );

      let failures = 0;
      for (const target of todo) {
        if (!this.running) {
          logger.info('Ratings sync cancelled', { label: 'Jobs' });
          return;
        }

        try {
          await fetchAndSaveRatings(target.tmdbId, target.mediaType);
        } catch (e) {
          failures++;
          logger.debug('Ratings sync: lookup failed', {
            label: 'Jobs',
            ...target,
            errorMessage: e.message,
          });
        }

        this.progress++;
        await sleep(DELAY_MS);
      }

      logger.info(
        `Ratings sync complete: ${this.progress - failures} updated, ${failures} failed`,
        { label: 'Jobs' }
      );
    } catch (e) {
      logger.error('Ratings sync failed', {
        label: 'Jobs',
        errorMessage: e.message,
      });
    } finally {
      this.reset();
    }
  }

  public status(): StatusBase {
    return {
      running: this.running,
      progress: this.progress,
      total: this.total,
    };
  }

  public cancel(): void {
    this.running = false;
  }

  private reset(): void {
    this.running = false;
    this.progress = 0;
    this.total = 0;
  }

  private async collectTargets(): Promise<Target[]> {
    const seen = new Set<string>();
    const targets: Target[] = [];
    const add = (tmdbId: number, mediaType: MediaType) => {
      const key = `${mediaType}:${tmdbId}`;
      if (tmdbId && !seen.has(key)) {
        seen.add(key);
        targets.push({ tmdbId, mediaType });
      }
    };

    // 1. Everything Seerr already knows about (library, requests, etc.)
    const media = await getRepository(Media).find({
      select: { tmdbId: true, mediaType: true },
    });
    media.forEach((m) => add(m.tmdbId, m.mediaType));

    // 2. Popular and well-known titles from TMDB
    const tmdb = new TheMovieDb();
    for (const sortBy of DISCOVER_SORTS) {
      for (let page = 1; page <= DISCOVER_PAGES; page++) {
        if (!this.running) {
          return targets;
        }
        try {
          const movies = await tmdb.getDiscoverMovies({ sortBy, page });
          movies.results.forEach((m) => add(m.id, MediaType.MOVIE));

          const shows = await tmdb.getDiscoverTv({ sortBy, page });
          shows.results.forEach((s) => add(s.id, MediaType.TV));
        } catch (e) {
          logger.debug('Ratings sync: TMDB discover page failed', {
            label: 'Jobs',
            sortBy,
            page,
            errorMessage: e.message,
          });
        }
      }
    }

    return targets;
  }

  private async filterStale(targets: Target[]): Promise<Target[]> {
    const result: Target[] = [];

    for (const mediaType of [MediaType.MOVIE, MediaType.TV]) {
      const ofType = targets.filter((t) => t.mediaType === mediaType);
      // Query in chunks to stay under SQLite's parameter limit
      for (let i = 0; i < ofType.length; i += 500) {
        const chunk = ofType.slice(i, i + 500);
        const cached = await getCachedRatings(
          chunk.map((t) => t.tmdbId),
          mediaType
        );
        chunk.forEach((t) => {
          if (isRatingStale(cached.get(t.tmdbId))) {
            result.push(t);
          }
        });
      }
    }

    return result;
  }
}

const ratingsSync = new RatingsSync();
export default ratingsSync;
