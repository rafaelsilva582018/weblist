import { db, getSetting } from '../db.js';
import { extractMetadataTitle } from '../parser/m3uParser.js';
import { compactSpaces, normalizeTitle, padNumber } from '../utils/normalize.js';

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

function getTmdbConfig() {
  return {
    apiKey: getSetting('tmdb_api_key', process.env.TMDB_API_KEY || ''),
    accessToken: getSetting('tmdb_access_token', process.env.TMDB_ACCESS_TOKEN || ''),
    language: getSetting('tmdb_language', process.env.TMDB_LANGUAGE || 'pt-BR')
  };
}

function getOmdbConfig() {
  return {
    apiKey: getSetting('omdb_api_key', process.env.OMDB_API_KEY || '')
  };
}

export function getTmdbPublicConfig() {
  const config = getTmdbConfig();
  return {
    configured: Boolean(config.apiKey || config.accessToken),
    language: config.language,
    apiKeyMasked: maskSecret(config.apiKey),
    accessTokenMasked: maskSecret(config.accessToken)
  };
}

export function getOmdbPublicConfig() {
  const config = getOmdbConfig();
  return {
    configured: Boolean(config.apiKey),
    apiKeyMasked: maskSecret(config.apiKey)
  };
}

export function getMetadataPublicConfig() {
  const tmdb = getTmdbPublicConfig();
  const omdb = getOmdbPublicConfig();
  return {
    configured: tmdb.configured || omdb.configured,
    tmdb,
    omdb,
    tvmaze: { configured: true }
  };
}

function maskSecret(value = '') {
  if (!value) return '';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function buildImageUrl(path, size = 'w500') {
  return path ? `${TMDB_IMAGE_BASE}/${size}${path}` : null;
}

function buildRequestUrl(endpoint, params, config) {
  const url = new URL(`${TMDB_API_BASE}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  if (config.apiKey && !config.accessToken) {
    url.searchParams.set('api_key', config.apiKey);
  }
  return url;
}

async function tmdbFetch(endpoint, params = {}) {
  const config = getTmdbConfig();
  if (!config.apiKey && !config.accessToken) {
    throw new Error('Configure uma chave TMDB no painel admin');
  }

  const url = buildRequestUrl(endpoint, { language: config.language, ...params }, config);
  const response = await fetch(url, {
    headers: config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}
  });

  if (!response.ok) {
    throw new Error(`TMDB respondeu ${response.status}`);
  }

  return response.json();
}

async function omdbFetch(params = {}) {
  const config = getOmdbConfig();
  if (!config.apiKey) return null;

  const url = new URL('https://www.omdbapi.com/');
  url.searchParams.set('apikey', config.apiKey);
  url.searchParams.set('plot', 'full');
  url.searchParams.set('r', 'json');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`OMDb respondeu ${response.status}`);

  const data = await response.json();
  return data?.Response === 'True' ? data : null;
}

async function tvmazeFetch(endpoint, params = {}) {
  const url = new URL(`https://api.tvmaze.com${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: { Accept: 'application/json' }
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`TVMaze respondeu ${response.status}`);
  return response.json();
}

function getYear(value) {
  if (!value) return null;
  const year = Number(String(value).slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

function validText(value) {
  const text = compactSpaces(value || '');
  if (!text || /^n\/a$/i.test(text)) return null;
  return text;
}

function stripHtml(value = '') {
  return compactSpaces(
    String(value)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/p>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/gi, '"')
  );
}

function mergeMetadata(primary, fallback) {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return {
    ...primary,
    overview: primary.overview || fallback.overview || null,
    posterUrl: primary.posterUrl || fallback.posterUrl || null,
    backdropUrl: primary.backdropUrl || fallback.backdropUrl || null,
    originalTitle: primary.originalTitle || fallback.originalTitle || null,
    releaseYear: primary.releaseYear || fallback.releaseYear || null,
    firstAirYear: primary.firstAirYear || fallback.firstAirYear || null
  };
}

function scoreResult(result, title, year, kind) {
  const expected = normalizeTitle(title);
  const names = kind === 'series'
    ? [result.name, result.original_name]
    : [result.title, result.original_title];

  const normalizedNames = names.filter(Boolean).map(normalizeTitle);
  let score = 0;

  if (normalizedNames.includes(expected)) score += 80;
  if (normalizedNames.some((name) => name.includes(expected) || expected.includes(name))) score += 25;
  if (result.poster_path) score += 12;
  if (result.backdrop_path) score += 4;
  if (year) {
    const resultYear = getYear(kind === 'series' ? result.first_air_date : result.release_date);
    if (resultYear === year) score += 18;
    if (resultYear && Math.abs(resultYear - year) === 1) score += 6;
  }
  score += Math.min(12, Number(result.vote_count || 0) / 100);

  return score;
}

function pickBestResult(results, title, year, kind) {
  return [...(results || [])]
    .filter((result) => result.poster_path || result.backdrop_path)
    .map((result) => ({ result, score: scoreResult(result, title, year, kind) }))
    .sort((a, b) => b.score - a.score)[0] || null;
}

export async function searchTmdbMovie(rawTitle) {
  const { title, year } = extractMetadataTitle(rawTitle);
  const data = await tmdbFetch('/search/movie', {
    query: title,
    year,
    include_adult: false,
    page: 1
  });
  const match = pickBestResult(data.results, title, year, 'movie');
  if (!match) return null;

  const item = match.result;
  return {
    tmdbId: item.id,
    title: item.title || title,
    originalTitle: item.original_title || null,
    overview: item.overview || null,
    posterUrl: buildImageUrl(item.poster_path, 'w500'),
    backdropUrl: buildImageUrl(item.backdrop_path, 'original'),
    releaseYear: getYear(item.release_date) || year,
    score: match.score
  };
}

export async function searchTmdbSeries(rawTitle) {
  const { title, year } = extractMetadataTitle(rawTitle);
  const data = await tmdbFetch('/search/tv', {
    query: title,
    first_air_date_year: year,
    include_adult: false,
    page: 1
  });
  const match = pickBestResult(data.results, title, year, 'series');
  if (!match) return null;

  const item = match.result;
  return {
    tmdbId: item.id,
    title: item.name || title,
    originalTitle: item.original_name || null,
    overview: item.overview || null,
    posterUrl: buildImageUrl(item.poster_path, 'w500'),
    backdropUrl: buildImageUrl(item.backdrop_path, 'original'),
    firstAirYear: getYear(item.first_air_date) || year,
    score: match.score
  };
}

async function searchOmdbMetadata(rawTitle, type) {
  const { title, year } = extractMetadataTitle(rawTitle);
  const data = await omdbFetch({
    t: title,
    y: year,
    type: type === 'series' ? 'series' : 'movie'
  });
  if (!data) return null;

  return {
    tmdbId: null,
    title: validText(data.Title) || title,
    originalTitle: validText(data.Title),
    overview: validText(data.Plot),
    posterUrl: validText(data.Poster),
    backdropUrl: null,
    releaseYear: type === 'movie' ? getYear(data.Released || data.Year) || year : null,
    firstAirYear: type === 'series' ? getYear(data.Year) || year : null,
    score: 45,
    metadataSource: 'omdb'
  };
}

async function searchTvMazeSeries(rawTitle) {
  const { title, year } = extractMetadataTitle(rawTitle);
  const data = await tvmazeFetch('/singlesearch/shows', { q: title });
  if (!data?.id) return null;

  const resultYear = getYear(data.premiered);
  const expected = normalizeTitle(title);
  const found = normalizeTitle(data.name || '');
  if (expected && found && expected !== found && !found.includes(expected) && !expected.includes(found)) return null;
  if (year && resultYear && Math.abs(year - resultYear) > 1) return null;

  return {
    tmdbId: null,
    title: data.name || title,
    originalTitle: data.name || null,
    overview: validText(stripHtml(data.summary || '')),
    posterUrl: data.image?.original || data.image?.medium || null,
    backdropUrl: null,
    firstAirYear: resultYear || year,
    score: 38,
    metadataSource: 'tvmaze'
  };
}

export async function searchMovieMetadata(rawTitle) {
  let primary = null;
  let primaryError = null;
  try {
    primary = await searchTmdbMovie(rawTitle);
  } catch (error) {
    primaryError = error;
  }

  const needsFallback = !primary || !primary.overview || !primary.posterUrl;
  const fallback = needsFallback ? await searchOmdbMetadata(rawTitle, 'movie').catch(() => null) : null;
  const merged = mergeMetadata(primary, fallback);
  if (merged) return merged;
  if (primaryError && !fallback) throw primaryError;
  return null;
}

export async function searchSeriesMetadata(rawTitle) {
  let primary = null;
  let primaryError = null;
  try {
    primary = await searchTmdbSeries(rawTitle);
  } catch (error) {
    primaryError = error;
  }

  const needsFallback = !primary || !primary.overview || !primary.posterUrl;
  if (!needsFallback) return primary;

  const omdb = await searchOmdbMetadata(rawTitle, 'series').catch(() => null);
  const tvmaze = await searchTvMazeSeries(rawTitle).catch(() => null);
  const merged = mergeMetadata(mergeMetadata(primary, omdb), tvmaze);
  if (merged) return merged;
  if (primaryError && !omdb && !tvmaze) throw primaryError;
  return null;
}

function mapMovieResult(item, score = null) {
  return {
    tmdbId: item.id,
    title: item.title || '',
    originalTitle: item.original_title || null,
    overview: item.overview || null,
    posterUrl: buildImageUrl(item.poster_path, 'w500'),
    backdropUrl: buildImageUrl(item.backdrop_path, 'original'),
    releaseYear: getYear(item.release_date),
    score,
    voteCount: item.vote_count || 0
  };
}

function mapSeasonSummary(season) {
  return {
    seasonNumber: Number(season.season_number),
    title: season.name || '',
    posterUrl: buildImageUrl(season.poster_path, 'w500'),
    episodes: []
  };
}

function mapSeasonDetails(season) {
  const seasonNumber = Number(season.season_number);
  return {
    ...mapSeasonSummary(season),
    episodes: (season.episodes || [])
      .map((episode) => ({
        seasonNumber,
        episodeNumber: Number(episode.episode_number),
        title: compactSpaces(episode.name || ''),
        overview: episode.overview || null,
        posterUrl: buildImageUrl(episode.still_path, 'w500')
      }))
      .filter((episode) => (
        Number.isInteger(episode.seasonNumber)
        && Number.isInteger(episode.episodeNumber)
        && episode.episodeNumber > 0
      ))
  };
}

function mergeSeasonDetails(primary, fallback) {
  if (!fallback) return primary;
  const fallbackEpisodes = new Map((fallback.episodes || []).map((episode) => [episode.episodeNumber, episode]));
  const episodes = (primary.episodes?.length ? primary.episodes : fallback.episodes || []).map((episode) => {
    const fallbackEpisode = fallbackEpisodes.get(episode.episodeNumber);
    const primaryTitleUseful = isUsefulEpisodeTitle(episode.title, episode.episodeNumber);
    return {
      ...episode,
      title: primaryTitleUseful ? episode.title : fallbackEpisode?.title || episode.title,
      overview: episode.overview || fallbackEpisode?.overview || null,
      posterUrl: episode.posterUrl || fallbackEpisode?.posterUrl || null
    };
  });

  return {
    ...primary,
    title: primary.title || fallback.title,
    posterUrl: primary.posterUrl || fallback.posterUrl,
    episodes
  };
}

async function getSeasonDetails(tmdbId, seasons = [], allowedSeasonNumbers = []) {
  const allowed = new Set(allowedSeasonNumbers.map(Number).filter(Number.isInteger));
  const language = getTmdbConfig().language || 'pt-BR';
  const candidates = seasons
    .map(mapSeasonSummary)
    .filter((season) => (
      Number.isInteger(season.seasonNumber)
      && season.seasonNumber >= 0
      && (!allowed.size || allowed.has(season.seasonNumber))
    ));

  const details = [];
  for (const season of candidates) {
    try {
      const data = await tmdbFetch(`/tv/${tmdbId}/season/${season.seasonNumber}`);
      let detail = mapSeasonDetails(data);

      if (language.toLowerCase() !== 'en-us' && detail.episodes.some((episode) => !isUsefulEpisodeTitle(episode.title, episode.episodeNumber))) {
        try {
          const fallback = await tmdbFetch(`/tv/${tmdbId}/season/${season.seasonNumber}`, { language: 'en-US' });
          detail = mergeSeasonDetails(detail, mapSeasonDetails(fallback));
        } catch {
          // Keep the configured language result when the fallback is unavailable.
        }
      }

      details.push(detail);
    } catch {
      details.push(season);
    }
  }
  return details;
}

function mapSeriesResult(item, score = null, seasons = null) {
  return {
    tmdbId: item.id,
    title: item.name || '',
    originalTitle: item.original_name || null,
    overview: item.overview || null,
    posterUrl: buildImageUrl(item.poster_path, 'w500'),
    backdropUrl: buildImageUrl(item.backdrop_path, 'original'),
    firstAirYear: getYear(item.first_air_date),
    score,
    voteCount: item.vote_count || 0,
    seasons: seasons || (item.seasons || [])
      .map(mapSeasonSummary)
      .filter((season) => Number.isInteger(season.seasonNumber) && season.seasonNumber >= 0 && (season.posterUrl || season.title))
  };
}

export async function searchTmdbCandidates(type, rawTitle) {
  const { title, year } = extractMetadataTitle(rawTitle);
  const kind = type === 'series' ? 'series' : 'movie';
  const endpoint = kind === 'series' ? '/search/tv' : '/search/movie';
  const params = kind === 'series'
    ? { query: title, first_air_date_year: year, include_adult: false, page: 1 }
    : { query: title, year, include_adult: false, page: 1 };
  const data = await tmdbFetch(endpoint, params);

  return (data.results || [])
    .map((item) => {
      const score = scoreResult(item, title, year, kind);
      return kind === 'series' ? mapSeriesResult(item, score) : mapMovieResult(item, score);
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 12);
}

export async function getTmdbById(type, tmdbId, options = {}) {
  const kind = type === 'series' ? 'series' : 'movie';
  const endpoint = kind === 'series' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
  const item = await tmdbFetch(endpoint);
  if (kind !== 'series') return mapMovieResult(item, 100);

  const seasons = options.includeEpisodes
    ? await getSeasonDetails(tmdbId, item.seasons || [], options.seasonNumbers || [])
    : null;
  return mapSeriesResult(item, 100, seasons);
}

function scorePersonResult(person, rawName) {
  const expected = normalizeTitle(rawName);
  const personName = normalizeTitle(person.name || '');
  let score = Number(person.popularity || 0);
  if (personName === expected) score += 120;
  if (personName.includes(expected) || expected.includes(personName)) score += 35;
  if (person.known_for_department === 'Acting') score += 25;
  score += Math.min(20, Number((person.known_for || []).length) * 4);
  return score;
}

export async function searchTmdbPersonCredits(rawName) {
  const query = compactSpaces(rawName || '');
  if (normalizeTitle(query).length < 3) {
    return { people: [], movies: [], series: [] };
  }

  const data = await tmdbFetch('/search/person', {
    query,
    include_adult: false,
    page: 1
  });

  const people = (data.results || [])
    .map((person) => ({ person, score: scorePersonResult(person, query) }))
    .filter(({ person }) => person.id && person.name)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ person, score }) => ({
      tmdbId: person.id,
      name: person.name,
      score
    }));

  const movies = new Map();
  const series = new Map();

  function addCredit(map, credit, person) {
    if (!credit?.id || !credit.media_type) return;
    if (!map.has(credit.id)) {
      map.set(credit.id, {
        tmdbId: credit.id,
        personName: person.name,
        character: credit.character || '',
        popularity: Number(credit.popularity || 0),
        rank: map.size
      });
    }
  }

  for (const person of people) {
    try {
      const credits = await tmdbFetch(`/person/${person.tmdbId}/combined_credits`);
      for (const credit of credits.cast || []) {
        if (credit.media_type === 'movie') addCredit(movies, credit, person);
        if (credit.media_type === 'tv') addCredit(series, credit, person);
      }
    } catch {
      // Keep title search working even when a person credits request fails.
    }
  }

  const byPopularity = (a, b) => b.popularity - a.popularity || a.rank - b.rank;
  return {
    people,
    movies: [...movies.values()].sort(byPopularity),
    series: [...series.values()].sort(byPopularity)
  };
}

export function updateMovieMetadata(id, match, force = false) {
  db.prepare(`
    UPDATE movies SET
      title = COALESCE(NULLIF(?, ''), title),
      poster_url = CASE WHEN ? OR poster_url IS NULL OR poster_url = '' THEN COALESCE(?, poster_url) ELSE poster_url END,
      backdrop_url = COALESCE(?, backdrop_url),
      overview = COALESCE(?, overview),
      original_title = COALESCE(?, original_title),
      release_year = COALESCE(?, release_year),
      tmdb_id = COALESCE(?, tmdb_id),
      tmdb_score = COALESCE(?, tmdb_score),
      metadata_updated_at = datetime('now')
    WHERE id = ?
  `).run(
    match.title,
    force ? 1 : 0,
    match.posterUrl,
    match.backdropUrl,
    match.overview,
    match.originalTitle,
    match.releaseYear,
    match.tmdbId,
    match.score,
    id
  );
  syncSearchIndex('movie', id);
}

export function updateSeriesMetadata(id, match, force = false) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE series SET
        title = COALESCE(NULLIF(?, ''), title),
        poster_url = CASE WHEN ? OR poster_url IS NULL OR poster_url = '' THEN COALESCE(?, poster_url) ELSE poster_url END,
        backdrop_url = COALESCE(?, backdrop_url),
        overview = COALESCE(?, overview),
        original_title = COALESCE(?, original_title),
        first_air_year = COALESCE(?, first_air_year),
        tmdb_id = COALESCE(?, tmdb_id),
        tmdb_score = COALESCE(?, tmdb_score),
        metadata_updated_at = datetime('now')
      WHERE id = ?
    `).run(
      match.title,
      force ? 1 : 0,
      match.posterUrl,
      match.backdropUrl,
      match.overview,
      match.originalTitle,
      match.firstAirYear,
      match.tmdbId,
      match.score,
      id
    );

    const seriesTitle = db.prepare('SELECT title FROM series WHERE id = ?').get(id)?.title || match.title || '';
    const selectEpisode = db.prepare(`
      SELECT id, title, display_title AS displayTitle, poster_url AS posterUrl
      FROM episodes
      WHERE series_id = ? AND season_number = ? AND episode_number = ?
      LIMIT 1
    `);
    const updateEpisode = db.prepare(`
      UPDATE episodes SET
        title = CASE WHEN ? THEN ? ELSE title END,
        display_title = CASE WHEN ? THEN ? ELSE display_title END,
        poster_url = CASE WHEN ? OR poster_url IS NULL OR poster_url = '' THEN COALESCE(?, poster_url) ELSE poster_url END
      WHERE id = ?
    `);

    for (const season of match.seasons || []) {
      db.prepare(`
        UPDATE seasons SET
          title = COALESCE(NULLIF(?, ''), title),
          poster_url = CASE WHEN ? OR poster_url IS NULL OR poster_url = '' THEN COALESCE(?, poster_url) ELSE poster_url END
        WHERE series_id = ? AND season_number = ?
      `).run(
        season.title,
        force ? 1 : 0,
        season.posterUrl,
        id,
        season.seasonNumber
      );

      for (const episode of season.episodes || []) {
        const episodeTitle = compactSpaces(episode.title || '');
        if (!isUsefulEpisodeTitle(episodeTitle, episode.episodeNumber) && !episode.posterUrl) continue;

        const current = selectEpisode.get(id, season.seasonNumber, episode.episodeNumber);
        if (!current) continue;

        const shouldUpdateTitle = isUsefulEpisodeTitle(episodeTitle, episode.episodeNumber)
          && shouldReplaceEpisodeTitle(current.title, seriesTitle, episode.episodeNumber, force);
        const displayTitle = `${seriesTitle} S${padNumber(season.seasonNumber)}E${padNumber(episode.episodeNumber)} - ${episodeTitle}`;

        updateEpisode.run(
          shouldUpdateTitle ? 1 : 0,
          episodeTitle,
          shouldUpdateTitle ? 1 : 0,
          displayTitle,
          force ? 1 : 0,
          episode.posterUrl,
          current.id
        );
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  syncSearchIndex('series', id);
}

function isUsefulEpisodeTitle(title = '', episodeNumber = 0) {
  const normalized = normalizeTitle(title);
  if (!normalized) return false;
  const number = Number(episodeNumber) || 0;
  return ![
    'tba',
    'a confirmar',
    `episode ${number}`,
    `episodio ${number}`,
    `episodio ${padNumber(number)}`
  ].includes(normalized);
}

function shouldReplaceEpisodeTitle(currentTitle = '', seriesTitle = '', episodeNumber = 0, force = false) {
  if (force) return true;
  const normalized = normalizeTitle(currentTitle);
  if (!normalized) return true;
  const number = Number(episodeNumber) || 0;
  if (normalized === normalizeTitle(seriesTitle)) return true;
  return [
    `episode ${number}`,
    `episodio ${number}`,
    `episodio ${padNumber(number)}`
  ].includes(normalized);
}

function syncSearchIndex(type, id) {
  db.prepare('DELETE FROM search_index WHERE type = ? AND content_id = ?').run(type, id);
  if (type === 'movie') {
    db.prepare(`
      INSERT INTO search_index (type, content_id, title, category, normalized)
      SELECT 'movie', m.id, m.title, COALESCE(c.name, ''), m.normalized_title
      FROM movies m
      LEFT JOIN categories c ON c.id = m.category_id
      WHERE m.id = ?
    `).run(id);
    return;
  }

  db.prepare(`
    INSERT INTO search_index (type, content_id, title, category, normalized)
    SELECT 'series', s.id, s.title, COALESCE(c.name, ''), s.normalized_title
    FROM series s
    LEFT JOIN categories c ON c.id = s.category_id
    WHERE s.id = ?
  `).run(id);
}
