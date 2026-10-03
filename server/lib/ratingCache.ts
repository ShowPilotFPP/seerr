import IMDBRadarrProxy, {
  type IMDBRating,
} from '@server/api/rating/imdbRadarrProxy';
import RottenTomatoes, {
  type RTRating,
} from '@server/api/rating/rottentomatoes';
import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Rating from '@server/entity/Rating';
import logger from '@server/logger';
import { In } from 'typeorm';

/** Cached ratings older than this are re-fetched. */
export const RATING_STALE_DAYS = 14;

const STALE_MS = RATING_STALE_DAYS * 24 * 60 * 60 * 1000;

export const isRatingStale = (rating?: Rating | null): boolean =>
  !rating ||
  !rating.lastCheckedAt ||
  Date.now() - new Date(rating.lastCheckedAt).getTime() > STALE_MS;

interface SaveRatingsInput {
  tmdbId: number;
  mediaType: MediaType;
  imdbId?: string | null;
  /** undefined = not checked (leave as-is), null = checked but not found */
  rt?: RTRating | null;
  /** undefined = not checked (leave as-is), null = checked but not found */
  imdb?: IMDBRating | null;
}

const toColumns = (input: SaveRatingsInput): Partial<Rating> => {
  const cols: Partial<Rating> = {
    tmdbId: input.tmdbId,
    mediaType: input.mediaType,
    lastCheckedAt: new Date(),
  };

  if (input.imdbId !== undefined) {
    cols.imdbId = input.imdbId;
  }

  if (input.rt !== undefined) {
    cols.rtCriticsScore = input.rt?.criticsScore ?? null;
    cols.rtAudienceScore = input.rt?.audienceScore ?? null;
    cols.rtCriticsRating = input.rt?.criticsRating ?? null;
    cols.rtUrl = input.rt?.url ?? null;
  }

  if (input.imdb !== undefined) {
    cols.imdbRating = input.imdb?.criticsScore ?? null;
    cols.imdbVoteCount = input.imdb?.criticsScoreCount ?? null;
  }

  return cols;
};

/**
 * Insert or update the cached ratings for one title in a single atomic
 * statement. Only the fields present in `input` are changed, so an RT-only
 * update never wipes a stored IMDb score (and vice versa).
 */
export const saveRatings = async (input: SaveRatingsInput): Promise<Rating> => {
  const repo = getRepository(Rating);

  await repo.upsert(toColumns(input), {
    conflictPaths: ['tmdbId', 'mediaType'],
    skipUpdateIfNoValuesChanged: false,
  });

  return repo.findOneOrFail({
    where: { tmdbId: input.tmdbId, mediaType: input.mediaType },
  });
};

/**
 * Same as saveRatings, but never throws. Used by the details-page routes so a
 * cache problem can never break the page.
 */
export const saveRatingsQuietly = (input: SaveRatingsInput): void => {
  saveRatings(input).catch((e) => {
    logger.debug('Failed to cache ratings', {
      label: 'Rating Cache',
      tmdbId: input.tmdbId,
      mediaType: input.mediaType,
      errorMessage: e.message,
    });
  });
};

/**
 * Look a title up on TMDB, Rotten Tomatoes and IMDb, then cache the result.
 * A source that errors (as opposed to "not found") is left unchanged so it
 * gets retried on the next run.
 */
export const fetchAndSaveRatings = async (
  tmdbId: number,
  mediaType: MediaType
): Promise<Rating> => {
  const tmdb = new TheMovieDb();
  const rtApi = new RottenTomatoes();

  let rt: RTRating | null | undefined;
  let imdb: IMDBRating | null | undefined;
  let imdbId: string | null | undefined;

  if (mediaType === MediaType.MOVIE) {
    const movie = await tmdb.getMovie({ movieId: tmdbId });
    const year = movie.release_date
      ? Number(movie.release_date.slice(0, 4))
      : 0;
    imdbId = movie.imdb_id || null;

    try {
      rt = await rtApi.getMovieRatings(movie.title, year);
    } catch {
      rt = undefined;
    }

    if (imdbId) {
      try {
        imdb = await new IMDBRadarrProxy().getMovieRatings(imdbId);
      } catch {
        imdb = undefined;
      }
    } else {
      imdb = null;
    }
  } else {
    const tv = await tmdb.getTvShow({ tvId: tmdbId });
    const year = tv.first_air_date
      ? Number(tv.first_air_date.slice(0, 4))
      : undefined;
    imdbId = tv.external_ids?.imdb_id || null;

    try {
      rt = await rtApi.getTVRatings(tv.name, year);
    } catch {
      rt = undefined;
    }
    // No IMDb score source for TV yet (Radarr's proxy is movies only).
  }

  if (rt === undefined && imdb === undefined && mediaType === MediaType.MOVIE) {
    throw new Error('All rating sources failed');
  }
  if (rt === undefined && mediaType === MediaType.TV) {
    throw new Error('Rotten Tomatoes lookup failed');
  }

  return saveRatings({ tmdbId, mediaType, imdbId, rt, imdb });
};

/**
 * Cached ratings for a batch of titles, keyed by TMDB ID. Titles with no
 * cache row are simply missing from the map.
 */
export const getCachedRatings = async (
  tmdbIds: number[],
  mediaType: MediaType
): Promise<Map<number, Rating>> => {
  if (tmdbIds.length === 0) {
    return new Map();
  }

  const rows = await getRepository(Rating).find({
    where: { tmdbId: In([...new Set(tmdbIds)]), mediaType },
  });

  return new Map(rows.map((r) => [r.tmdbId, r]));
};

/* ------------------------------------------------------------------ */
/* Background lookup queue                                             */
/* ------------------------------------------------------------------ */

const QUEUE_LIMIT = 1000;
const QUEUE_CONCURRENCY = 2;
const QUEUE_DELAY_MS = 300;

const queue: { tmdbId: number; mediaType: MediaType }[] = [];
const queued = new Set<string>();
let activeWorkers = 0;

const runWorker = async (): Promise<void> => {
  activeWorkers++;
  try {
    let item = queue.shift();
    while (item) {
      try {
        await fetchAndSaveRatings(item.tmdbId, item.mediaType);
      } catch (e) {
        logger.debug('Queued rating lookup failed', {
          label: 'Rating Cache',
          ...item,
          errorMessage: e.message,
        });
      } finally {
        queued.delete(`${item.mediaType}:${item.tmdbId}`);
      }
      await new Promise((r) => setTimeout(r, QUEUE_DELAY_MS));
      item = queue.shift();
    }
  } finally {
    activeWorkers--;
  }
};

/**
 * Look up ratings for these titles in the background (deduplicated,
 * rate-limited). Returns immediately. Used by Discover so that titles
 * missing from the cache are filled in for the next visit.
 */
export const queueRatingLookups = (
  items: { tmdbId: number; mediaType: MediaType }[]
): void => {
  for (const item of items) {
    const key = `${item.mediaType}:${item.tmdbId}`;
    if (queued.has(key) || queue.length >= QUEUE_LIMIT) {
      continue;
    }
    queued.add(key);
    queue.push(item);
  }

  while (activeWorkers < QUEUE_CONCURRENCY && queue.length > 0) {
    runWorker();
  }
};
