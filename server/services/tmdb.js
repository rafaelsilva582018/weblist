import { db, getSetting } from '../db.js';
import { extractMetadataTitle } from '../parser/m3uParser.js';
import { normalizeTitle } from '../utils/normalize.js';

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

function getTmdbConfig() {
  return {
    apiKey: getSetting('tmdb_api_key', process.env.TMDB_API_KEY || ''),
    accessToken: getSetting('tmdb_access_token', process.env.TMDB_ACCESS_TOKEN || ''),
    language: getSetting('tmdb_language', process.env.TMDB_LANGUAGE || 'pt-BR')
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

function getYear(value) {
  if (!value) return null;
  const year = Number(String(value).slice(0, 4));
  return Number.isFinite(year) ? year : null;
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

function mapSeriesResult(item, score = null) {
  return {
    tmdbId: item.id,
    title: item.name || '',
    originalTitle: item.original_name || null,
    overview: item.overview || null,
    posterUrl: buildImageUrl(item.poster_path, 'w500'),
    backdropUrl: buildImageUrl(item.backdrop_path, 'original'),
    firstAirYear: getYear(item.first_air_date),
    score,
    voteCount: item.vote_count || 0
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

export async function getTmdbById(type, tmdbId) {
  const kind = type === 'series' ? 'series' : 'movie';
  const endpoint = kind === 'series' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
  const item = await tmdbFetch(endpoint);
  return kind === 'series' ? mapSeriesResult(item, 100) : mapMovieResult(item, 100);
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
  syncSearchIndex('series', id);
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
