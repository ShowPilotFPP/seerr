import { MediaType } from '@server/constants/media';
import type Rating from '@server/entity/Rating';
import {
  getCachedRatings,
  isRatingStale,
  queueRatingLookups,
} from '@server/lib/ratingCache';

/**
 * How many TMDB pages (20 titles each) one Discover page scans when a
 * rating filter is active. Higher = fuller pages, slower loads.
 */
export const RATING_FILTER_WINDOW = 5;

/** TMDB refuses to serve discover pages past 500. */
const TMDB_MAX_PAGE = 500;

export interface RatingFilterQuery {
  rtCriticsGte?: string;
  rtCriticsLte?: string;
  rtAudienceGte?: string;
  rtAudienceLte?: string;
  imdbRatingGte?: string;
  imdbRatingLte?: string;
}

interface Bound {
  field: 'rtCriticsScore' | 'rtAudienceScore' | 'imdbRating';
  gte?: number;
  lte?: number;
}

const toNum = (v?: string): number | undefined => {
  if (v === undefined || v === '') {
    return undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const getBounds = (query: RatingFilterQuery, mediaType: MediaType): Bound[] => {
  const bounds: Bound[] = [
    {
      field: 'rtCriticsScore',
      gte: toNum(query.rtCriticsGte),
      lte: toNum(query.rtCriticsLte),
    },
    {
      field: 'rtAudienceScore',
      gte: toNum(query.rtAudienceGte),
      lte: toNum(query.rtAudienceLte),
    },
  ];

  // There is no IMDb score source for TV, so ignore that filter there.
  if (mediaType === MediaType.MOVIE) {
    bounds.push({
      field: 'imdbRating',
      gte: toNum(query.imdbRatingGte),
      lte: toNum(query.imdbRatingLte),
    });
  }

  return bounds.filter((b) => b.gte !== undefined || b.lte !== undefined);
};

const passes = (rating: Rating | undefined, bounds: Bound[]): boolean =>
  bounds.every((b) => {
    const value = rating?.[b.field];
    // A title with no score can't satisfy a score filter.
    if (value === null || value === undefined) {
      return false;
    }
    if (b.gte !== undefined && value < b.gte) {
      return false;
    }
    if (b.lte !== undefined && value > b.lte) {
      return false;
    }
    return true;
  });

export const hasRatingFilter = (
  query: RatingFilterQuery,
  mediaType: MediaType
): boolean => getBounds(query, mediaType).length > 0;

interface DiscoverPage<T extends { id: number }> {
  page: number;
  total_pages: number;
  total_results: number;
  results: T[];
}

/**
 * Wraps a TMDB discover call. With no rating filter active it behaves
 * exactly like the original (one TMDB page per Discover page).
 *
 * With a rating filter, Discover page N scans a window of TMDB pages and
 * returns only titles whose cached ratings match. Titles that aren't cached
 * yet (or are stale) are queued for a background lookup, so results get
 * fuller the more the filter is used and as the Ratings Sync job runs.
 */
export const discoverWithRatingFilter = async <T extends { id: number }>(
  query: RatingFilterQuery & { page?: string },
  mediaType: MediaType,
  fetchPage: (page: number) => Promise<DiscoverPage<T>>
): Promise<DiscoverPage<T> & { ratingFiltered?: boolean }> => {
  const page = Math.max(1, Number(query.page) || 1);
  const bounds = getBounds(query, mediaType);

  if (bounds.length === 0) {
    return fetchPage(page);
  }

  const firstTmdbPage = (page - 1) * RATING_FILTER_WINDOW + 1;
  const first = await fetchPage(firstTmdbPage);
  const lastAvailable = Math.min(first.total_pages, TMDB_MAX_PAGE);

  const rest = await Promise.all(
    Array.from(
      { length: RATING_FILTER_WINDOW - 1 },
      (_, i) => firstTmdbPage + i + 1
    )
      .filter((p) => p <= lastAvailable)
      .map((p) => fetchPage(p))
  );

  // Deduplicate: TMDB pages can shift slightly between requests
  const seen = new Set<number>();
  const candidates = [first, ...rest]
    .flatMap((p) => p.results)
    .filter((r) => !seen.has(r.id) && seen.add(r.id));

  const cache = await getCachedRatings(
    candidates.map((c) => c.id),
    mediaType
  );

  queueRatingLookups(
    candidates
      .filter((c) => isRatingStale(cache.get(c.id)))
      .map((c) => ({ tmdbId: c.id, mediaType }))
  );

  return {
    page,
    total_pages: Math.ceil(lastAvailable / RATING_FILTER_WINDOW),
    total_results: first.total_results,
    results: candidates.filter((c) => passes(cache.get(c.id), bounds)),
    ratingFiltered: true,
  };
};
