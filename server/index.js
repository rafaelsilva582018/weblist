import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { clearLibrary, db, ensureSearchIndex, getSetting, getStats, initDatabase, projectRoot, rebuildSearchIndex, setSetting, uploadsDir } from './db.js';
import { getActiveAiMetadataJob, getAiMetadataJob, getAiMetadataPublicConfig, queueAiMetadataAssistant, updateAiMetadataJob } from './services/aiMetadata.js';
import { getActiveEnrichJob, getEnrichJob, queueTmdbEnrichment, updateEnrichJob } from './services/enricher.js';
import { attachCurrentPrograms, getChannelGuide, getCurrentProgram, getEpgJob, getEpgStatus, getNextProgram, queueEpgImport } from './services/epg.js';
import { getImportJob, queueImport } from './services/importer.js';
import { getIptvOrgEpgJob, queueIptvOrgEpgImport } from './services/iptvOrgEpg.js';
import { getOmdbPublicConfig, getTmdbById, getTmdbPublicConfig, searchTmdbCandidates, searchTmdbPersonCredits, updateMovieMetadata, updateSeriesMetadata } from './services/tmdb.js';
import { normalizeTitle } from './utils/normalize.js';
import { startAutoTmdbEnrichment } from './services/autoTmdb.js';

const app = express();
const port = Number(process.env.PORT || 3333);
const jwtSecret = process.env.JWT_SECRET || 'weblist-local-secret';
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '30d';
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 1024 * 1024 * 700 }
});

initDatabase();
ensureSearchIndex();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: true, limit: '150mb' }));
app.use('/api/uploads', express.static(uploadsDir));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function parseTmdbReference(value = '') {
  const text = String(value || '').trim();
  if (!text) return { id: 0, type: '' };

  const numberOnly = text.match(/^\d+$/);
  if (numberOnly) return { id: Number(numberOnly[0]), type: '' };

  const urlText = /^https?:\/\//i.test(text) ? text : `https://www.themoviedb.org/${text.replace(/^\/+/, '')}`;
  try {
    const url = new URL(urlText);
    const [mediaType, idPart] = url.pathname.split('/').filter(Boolean);
    const id = Number(String(idPart || '').match(/^\d+/)?.[0] || 0);
    if (id && ['movie', 'tv'].includes(String(mediaType || '').toLowerCase())) {
      return { id, type: mediaType.toLowerCase() === 'tv' ? 'series' : 'movie' };
    }
  } catch {
    // Fall back to the loose matcher below.
  }

  const loose = text.match(/(?:^|\/)(movie|tv)\/(\d+)/i);
  if (loose) return { id: Number(loose[2]), type: loose[1].toLowerCase() === 'tv' ? 'series' : 'movie' };

  return { id: 0, type: '' };
}

function compactInput(value = '', maxLength = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function boolInput(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function formatUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || '',
    email: user.email || '',
    avatarUrl: user.avatar_url || '',
    isAdmin: Boolean(user.is_admin),
    canViewAdult: Boolean(user.can_view_adult),
    preferHideAdult: user.prefer_hide_adult !== 0,
    autoplayNext: user.autoplay_next !== 0,
    watchedCount: Number(user.watched_count || 0),
    progressCount: Number(user.progress_count || 0),
    createdAt: user.created_at
  };
}

function listUsers() {
  return db
    .prepare(`
      SELECT
        u.id,
        u.username,
        u.display_name,
        u.email,
        u.avatar_url,
        u.is_admin,
        u.can_view_adult,
        u.prefer_hide_adult,
        u.autoplay_next,
        u.created_at,
        COUNT(wp.id) AS progress_count,
        SUM(CASE WHEN wp.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS watched_count
      FROM users u
      LEFT JOIN watch_progress wp ON wp.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at ASC, u.id ASC
    `)
    .all()
    .map(formatUser);
}

function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: 'Login necessario' });
    const payload = jwt.verify(token, jwtSecret);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(payload.sub));
    if (!user) return res.status(401).json({ error: 'Sessao expirada' });
    req.user = formatUser(user);
    return next();
  } catch {
    return res.status(401).json({ error: 'Sessao expirada' });
  }
}

function requireAdmin(req, res, next) {
  return requireAuth(req, res, () => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Acesso restrito ao administrador' });
    return next();
  });
}

function getLocalUserId(req) {
  return getLocalUser(req).id;
}

function getLocalUser(req) {
  try {
    const token = getBearerToken(req);
    if (!token) return { id: 1, username: 'local', isAdmin: false, canViewAdult: false };
    const payload = jwt.verify(token, jwtSecret);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(payload.sub));
    return user ? formatUser(user) : { id: 1, username: 'local', isAdmin: false, canViewAdult: false };
  } catch {
    return { id: 1, username: 'local', isAdmin: false, canViewAdult: false };
  }
}

function signUser(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, isAdmin: Boolean(user.is_admin), canViewAdult: Boolean(user.can_view_adult) },
    jwtSecret,
    { expiresIn: jwtExpiresIn }
  );
}

function parseLimit(value, fallback = 40, max = 120) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

function parsePage(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(parsed, 1);
}

function paginationMeta(total, page, limit) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1
  };
}

function buildFtsQuery(q) {
  const tokens = normalizeTitle(q).split(/\s+/).filter((token) => token.length > 1).slice(0, 8);
  return tokens.map((token) => `${token}*`).join(' ');
}

function extractYearSearch(q = '', explicitYear = '', type = '') {
  const hasYearColumn = type !== 'channel';
  const explicit = /^\d{4}$/.test(String(explicitYear || '')) ? Number(explicitYear) : null;
  if (!hasYearColumn) return { q, year: null };
  if (explicit) {
    return {
      q: String(q || '').replace(/\b(19\d{2}|20\d{2})\b/g, ' ').replace(/\s+/g, ' ').trim(),
      year: explicit
    };
  }

  const match = String(q || '').match(/\b(19\d{2}|20\d{2})\b/);
  if (!match) return { q, year: null };

  return {
    q: String(q || '').replace(match[0], ' ').replace(/\s+/g, ' ').trim(),
    year: Number(match[0])
  };
}

function shouldHideAdult(value) {
  return !['0', 'false', 'no'].includes(String(value ?? 'true').toLowerCase());
}

function canShowAdult(user) {
  return Boolean(user?.canViewAdult);
}

function effectiveHideAdult(req, user = getLocalUser(req)) {
  return canShowAdult(user) ? shouldHideAdult(req.query.hideAdult) : true;
}

function adultFilterClauses(alias, categoryAlias = 'c') {
  return [
    `COALESCE(${categoryAlias}.name, '') NOT LIKE '%Adult%' COLLATE NOCASE`,
    `COALESCE(${categoryAlias}.name, '') NOT LIKE '%XXX%' COLLATE NOCASE`,
    `COALESCE(${categoryAlias}.name, '') NOT LIKE '%+18%' COLLATE NOCASE`,
    `${alias}.title NOT LIKE '%[XXX]%' COLLATE NOCASE`,
    `${alias}.title NOT LIKE '%XXX%' COLLATE NOCASE`,
    `${alias}.title NOT LIKE '%18+%' COLLATE NOCASE`,
    `${alias}.title NOT LIKE '%+18%' COLLATE NOCASE`,
    `${alias}.title NOT LIKE '%sexo%' COLLATE NOCASE`,
    `${alias}.title NOT LIKE '%porn%' COLLATE NOCASE`,
    `${alias}.title NOT LIKE '%erot%' COLLATE NOCASE`
  ];
}

function addAdultFilters(where, alias, categoryAlias = 'c') {
  where.push(...adultFilterClauses(alias, categoryAlias));
}

function isAdultRecord(record = {}) {
  if (!record) return false;
  const text = `${record.title || ''} ${record.category || ''}`;
  return /adult|xxx|\+18|18\+|sexo|porn|erot/i.test(text);
}

function addSearchFilters({ where, params, alias, type, q, category, metadata = 'all', year = '', hideAdult = true }) {
  const search = extractYearSearch(q, year, type);
  if (search.q) {
    const fts = buildFtsQuery(search.q);
    if (fts) {
      where.push(`${alias}.id IN (SELECT content_id FROM search_index WHERE type = ? AND search_index MATCH ?)`);
      params.push(type, fts);
    }
  }

  if (category && category !== 'all') {
    if (/^\d+$/.test(String(category))) {
      where.push(`${alias}.category_id = ?`);
      params.push(Number(category));
    } else {
      where.push('c.name = ? COLLATE NOCASE');
      params.push(category);
    }
  }

  if (hideAdult) {
    addAdultFilters(where, alias);
  }

  if (search.year) {
    const column = type === 'series' ? 'first_air_year' : 'release_year';
    if (type !== 'channel') {
      where.push(`${alias}.${column} = ?`);
      params.push(search.year);
    }
  }

  if (type !== 'channel') {
    if (metadata === 'missingPoster') where.push(`(${alias}.poster_url IS NULL OR ${alias}.poster_url = '')`);
    if (metadata === 'withPoster') where.push(`(${alias}.poster_url IS NOT NULL AND ${alias}.poster_url != '')`);
    if (metadata === 'missingOverview') where.push(`(${alias}.overview IS NULL OR ${alias}.overview = '')`);
    if (metadata === 'withOverview') where.push(`(${alias}.overview IS NOT NULL AND ${alias}.overview != '')`);
    if (metadata === 'missingAny') {
      where.push(`(
        ${alias}.tmdb_id IS NULL OR ${alias}.poster_url IS NULL OR ${alias}.poster_url = '' OR
        ${alias}.backdrop_url IS NULL OR ${alias}.backdrop_url = '' OR
        ${alias}.overview IS NULL OR ${alias}.overview = ''
      )`);
    }
  }
}

function whereClause(where) {
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

function streamFormat(url = '') {
  const clean = String(url).split('?')[0].toLowerCase();
  if (clean.endsWith('.m3u8')) return 'hls';
  if (clean.endsWith('.ts')) return 'mpegts';
  if (clean.endsWith('.mp4')) return 'mp4';
  return 'auto';
}

function sourceHost(streamUrl = '') {
  try {
    return new URL(streamUrl).host.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function getStreamSources(contentType, contentId, fallbackUrl = '') {
  const rows = db.prepare(`
    SELECT
      id,
      COALESCE(NULLIF(label, ''), 'Opcao') AS label,
      stream_url AS streamUrl,
      source_host AS sourceHost,
      is_primary AS isPrimary
    FROM stream_sources
    WHERE content_type = ? AND content_id = ?
    ORDER BY is_primary DESC, id ASC
  `).all(contentType, contentId);

  const sources = rows.length ? rows : (fallbackUrl ? [{
    id: null,
    label: 'Opcao 1',
    streamUrl: fallbackUrl,
    sourceHost: sourceHost(fallbackUrl),
    isPrimary: 1
  }] : []);

  return sources.map((source, index) => ({
    ...source,
    label: source.label === 'Opcao' ? `Opcao ${index + 1}` : source.label,
    sourceHost: source.sourceHost || sourceHost(source.streamUrl),
    isPrimary: Boolean(source.isPrimary)
  }));
}

function publicSources(sources) {
  return sources.map(({ streamUrl, ...source }) => source);
}

function pickStreamSource(sources, requestedSource) {
  const sourceId = Number(requestedSource || 0);
  if (sourceId) {
    const selected = sources.find((source) => Number(source.id) === sourceId);
    if (selected) return selected;
  }
  return sources.find((source) => source.isPrimary) || sources[0] || null;
}

const favoriteTables = {
  movie: 'movies',
  series: 'series',
  channel: 'channels'
};

function normalizeFavoriteType(type) {
  const value = String(type || '').toLowerCase();
  return favoriteTables[value] ? value : null;
}

function contentExists(type, id) {
  const table = favoriteTables[type];
  if (!table) return false;
  return Boolean(db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id));
}

function getContentAdultRecord(type, id) {
  if (type === 'movie') {
    return db.prepare(`
      SELECT m.title, c.name AS category
      FROM movies m
      LEFT JOIN categories c ON c.id = m.category_id
      WHERE m.id = ?
    `).get(id);
  }

  if (type === 'series') {
    return db.prepare(`
      SELECT s.title, c.name AS category
      FROM series s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE s.id = ?
    `).get(id);
  }

  if (type === 'channel') {
    return db.prepare(`
      SELECT ch.title, c.name AS category
      FROM channels ch
      LEFT JOIN categories c ON c.id = ch.category_id
      WHERE ch.id = ?
    `).get(id);
  }

  return null;
}

function canAccessContent(user, type, id) {
  return canShowAdult(user) || !isAdultRecord(getContentAdultRecord(type, id));
}

function isFavorite(userId, type, id) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM favorites
    WHERE user_id = ? AND content_type = ? AND content_id = ?
  `).get(userId, type, id));
}

function listFavorites(userId, { type = 'all', limit = 60, page = 1, hideAdult = true }) {
  const filterType = type === 'all' ? null : normalizeFavoriteType(type);
  if (type !== 'all' && !filterType) {
    return { items: [], pagination: paginationMeta(0, page, limit) };
  }

  const offset = (page - 1) * limit;
  const includedTypes = filterType ? [filterType] : ['movie', 'series', 'channel'];
  const parts = [];
  const countParts = [];
  const params = [];
  const countParams = [];
  const movieAdultClause = hideAdult ? `AND ${adultFilterClauses('m').join(' AND ')}` : '';
  const seriesAdultClause = hideAdult ? `AND ${adultFilterClauses('s').join(' AND ')}` : '';
  const channelAdultClause = hideAdult ? `AND ${adultFilterClauses('ch').join(' AND ')}` : '';

  if (includedTypes.includes('movie')) {
    const movieFrom = `
      FROM favorites f
      JOIN movies m ON m.id = f.content_id
      LEFT JOIN categories c ON c.id = m.category_id
      WHERE f.user_id = ? AND f.content_type = 'movie'
      ${movieAdultClause}
    `;
    parts.push(`
      SELECT
        f.created_at AS favoritedAt,
        m.id, 'movie' AS type, m.title, m.poster_url AS posterUrl, m.imported_at AS importedAt,
        m.backdrop_url AS backdropUrl, m.overview, m.release_year AS releaseYear, NULL AS firstAirYear,
        c.id AS categoryId, c.name AS category, 1 AS isFavorite
      ${movieFrom}
    `);
    countParts.push(`SELECT f.id ${movieFrom}`);
    params.push(userId);
    countParams.push(userId);
  }

  if (includedTypes.includes('series')) {
    const seriesFrom = `
      FROM favorites f
      JOIN series s ON s.id = f.content_id
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE f.user_id = ? AND f.content_type = 'series'
      ${seriesAdultClause}
    `;
    parts.push(`
      SELECT
        f.created_at AS favoritedAt,
        s.id, 'series' AS type, s.title, s.poster_url AS posterUrl, s.imported_at AS importedAt,
        s.backdrop_url AS backdropUrl, s.overview, NULL AS releaseYear, s.first_air_year AS firstAirYear,
        c.id AS categoryId, c.name AS category, 1 AS isFavorite
      ${seriesFrom}
    `);
    countParts.push(`SELECT f.id ${seriesFrom}`);
    params.push(userId);
    countParams.push(userId);
  }

  if (includedTypes.includes('channel')) {
    const channelFrom = `
      FROM favorites f
      JOIN channels ch ON ch.id = f.content_id
      LEFT JOIN categories c ON c.id = ch.category_id
      WHERE f.user_id = ? AND f.content_type = 'channel'
      ${channelAdultClause}
    `;
    parts.push(`
      SELECT
        f.created_at AS favoritedAt,
        ch.id, 'channel' AS type, ch.title, ch.logo_url AS posterUrl, ch.imported_at AS importedAt,
        NULL AS backdropUrl, NULL AS overview, NULL AS releaseYear, NULL AS firstAirYear,
        c.id AS categoryId, c.name AS category, 1 AS isFavorite
      ${channelFrom}
    `);
    countParts.push(`SELECT f.id ${channelFrom}`);
    params.push(userId);
    countParams.push(userId);
  }

  const total = countParts.length
    ? db.prepare(`SELECT COUNT(*) AS total FROM (${countParts.join(' UNION ALL ')})`).get(...countParams).total
    : 0;

  if (!parts.length || total === 0) {
    return { items: [], pagination: paginationMeta(total, page, limit) };
  }

  const items = db.prepare(`
    SELECT *
    FROM (${parts.join(' UNION ALL ')})
    ORDER BY favoritedAt DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { items: attachCurrentPrograms(items), pagination: paginationMeta(total, page, limit) };
}

function queryMoviesByTmdbCredits(credits = [], { category = '', metadata = 'all', year = '', hideAdult = true, userId = 1 }) {
  if (!credits.length) return [];
  const creditMap = new Map(credits.map((credit, index) => [Number(credit.tmdbId), { ...credit, rank: index }]));
  const where = [`m.tmdb_id IN (${credits.map(() => '?').join(',')})`];
  const params = credits.map((credit) => Number(credit.tmdbId));
  addSearchFilters({ where, params, alias: 'm', type: 'movie', q: '', category, metadata, year, hideAdult });

  return db.prepare(`
    SELECT
      m.id, 'movie' AS type, m.title, m.poster_url AS posterUrl, m.imported_at AS importedAt,
      m.backdrop_url AS backdropUrl, m.overview, m.release_year AS releaseYear, m.tmdb_id AS tmdbId,
      c.id AS categoryId, c.name AS category,
      EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.content_type = 'movie' AND f.content_id = m.id) AS isFavorite
    FROM movies m
    LEFT JOIN categories c ON c.id = m.category_id
    ${whereClause(where)}
  `).all(userId, ...params)
    .map((item) => {
      const credit = creditMap.get(Number(item.tmdbId));
      return {
        ...item,
        matchSource: 'actor',
        actorName: credit?.personName || '',
        character: credit?.character || '',
        actorRank: credit?.rank ?? 9999
      };
    })
    .sort((a, b) => a.actorRank - b.actorRank || a.title.localeCompare(b.title));
}

function querySeriesByTmdbCredits(credits = [], { category = '', metadata = 'all', year = '', hideAdult = true, userId = 1 }) {
  if (!credits.length) return [];
  const creditMap = new Map(credits.map((credit, index) => [Number(credit.tmdbId), { ...credit, rank: index }]));
  const where = [`s.tmdb_id IN (${credits.map(() => '?').join(',')})`];
  const params = credits.map((credit) => Number(credit.tmdbId));
  addSearchFilters({ where, params, alias: 's', type: 'series', q: '', category, metadata, year, hideAdult });

  return db.prepare(`
    SELECT
      s.id, 'series' AS type, s.title, s.poster_url AS posterUrl, s.imported_at AS importedAt,
      s.backdrop_url AS backdropUrl, s.overview, s.first_air_year AS firstAirYear, s.tmdb_id AS tmdbId,
      c.id AS categoryId, c.name AS category,
      COUNT(DISTINCT seasons.id) AS seasonCount,
      COUNT(DISTINCT episodes.id) AS episodeCount,
      EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.content_type = 'series' AND f.content_id = s.id) AS isFavorite
    FROM series s
    LEFT JOIN categories c ON c.id = s.category_id
    LEFT JOIN seasons ON seasons.series_id = s.id
    LEFT JOIN episodes ON episodes.series_id = s.id
    ${whereClause(where)}
    GROUP BY s.id
  `).all(userId, ...params)
    .map((item) => {
      const credit = creditMap.get(Number(item.tmdbId));
      return {
        ...item,
        matchSource: 'actor',
        actorName: credit?.personName || '',
        character: credit?.character || '',
        actorRank: credit?.rank ?? 9999
      };
    })
    .sort((a, b) => a.actorRank - b.actorRank || a.title.localeCompare(b.title));
}

async function findPersonCreditMatches({ q, type = 'all', category = '', metadata = 'all', year = '', hideAdult = true, userId = 1 }) {
  if (!q || normalizeTitle(q).length < 3 || type === 'channel') return [];

  try {
    const credits = await searchTmdbPersonCredits(q);
    const items = [];
    if (type === 'all' || type === 'movie') {
      items.push(...queryMoviesByTmdbCredits(credits.movies, { category, metadata, year, hideAdult, userId }));
    }
    if (type === 'all' || type === 'series') {
      items.push(...querySeriesByTmdbCredits(credits.series, { category, metadata, year, hideAdult, userId }));
    }
    return items;
  } catch {
    return [];
  }
}

function mergeSearchItems(items, extraItems) {
  const seen = new Set(items.map((item) => `${item.type}:${item.id}`));
  const merged = [...items];
  let added = 0;

  for (const item of extraItems) {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    added += 1;
  }

  return { items: merged, added };
}

function mediaSearch({ q = '', type = 'all', limit = 30 }) {
  const raw = String(q || '').trim();
  const normalized = normalizeTitle(raw);
  if (!raw) return [];

  const like = `%${raw}%`;
  const normalizedLike = `%${normalized}%`;
  const year = raw.match(/^\d{4}$/) ? Number(raw) : null;
  const items = [];

  if (type === 'all' || type === 'movie') {
    items.push(...db.prepare(`
      SELECT
        m.id, 'movie' AS type, m.title, m.poster_url AS posterUrl,
        m.backdrop_url AS backdropUrl, m.overview, m.release_year AS releaseYear, c.name AS category
      FROM movies m
      LEFT JOIN categories c ON c.id = m.category_id
      WHERE m.title LIKE ? COLLATE NOCASE OR m.normalized_title LIKE ? COLLATE NOCASE OR (? IS NOT NULL AND m.release_year = ?)
      ORDER BY COALESCE(m.release_year, 0) DESC, m.title COLLATE NOCASE
      LIMIT ?
    `).all(like, normalizedLike, year, year, limit));
  }

  if (type === 'all' || type === 'series') {
    items.push(...db.prepare(`
      SELECT
        s.id, 'series' AS type, s.title, s.poster_url AS posterUrl,
        s.backdrop_url AS backdropUrl, s.overview, s.first_air_year AS firstAirYear, c.name AS category
      FROM series s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE s.title LIKE ? COLLATE NOCASE OR s.normalized_title LIKE ? COLLATE NOCASE OR (? IS NOT NULL AND s.first_air_year = ?)
      ORDER BY COALESCE(s.first_air_year, 0) DESC, s.title COLLATE NOCASE
      LIMIT ?
    `).all(like, normalizedLike, year, year, limit));
  }

  if (type === 'all' || type === 'channel') {
    items.push(...db.prepare(`
      SELECT
        ch.id, 'channel' AS type, ch.title, ch.logo_url AS posterUrl,
        NULL AS backdropUrl, NULL AS overview, c.name AS category
      FROM channels ch
      LEFT JOIN categories c ON c.id = ch.category_id
      WHERE ch.title LIKE ? COLLATE NOCASE OR ch.normalized_title LIKE ? COLLATE NOCASE
      ORDER BY ch.title COLLATE NOCASE
      LIMIT ?
    `).all(like, normalizedLike, limit));
  }

  return items.slice(0, limit);
}

function updateManualMetadata({ type, id, title = '', overview = '', posterUrl = '', backdropUrl = '' }) {
  const cleanTitle = String(title || '').trim();
  const normalized = cleanTitle ? normalizeTitle(cleanTitle) : '';
  const cleanPoster = String(posterUrl || '').trim();
  const cleanBackdrop = String(backdropUrl || '').trim();
  const cleanOverview = String(overview || '').trim();

  if (type === 'channel') {
    db.prepare(`
      UPDATE channels SET
        title = COALESCE(NULLIF(?, ''), title),
        normalized_title = CASE WHEN ? != '' THEN ? ELSE normalized_title END,
        tvg_name = COALESCE(NULLIF(?, ''), tvg_name),
        logo_url = CASE WHEN ? != '' THEN ? ELSE logo_url END
      WHERE id = ?
    `).run(cleanTitle, normalized, normalized, cleanTitle, cleanPoster, cleanPoster, id);
    rebuildSearchIndex();
    return;
  }

  const table = type === 'series' ? 'series' : 'movies';
  db.prepare(`
    UPDATE ${table} SET
      title = COALESCE(NULLIF(?, ''), title),
      normalized_title = CASE WHEN ? != '' THEN ? ELSE normalized_title END,
      poster_url = CASE WHEN ? != '' THEN ? ELSE poster_url END,
      backdrop_url = CASE WHEN ? != '' THEN ? ELSE backdrop_url END,
      overview = CASE WHEN ? != '' THEN ? ELSE overview END,
      metadata_updated_at = datetime('now')
    WHERE id = ?
  `).run(
    cleanTitle,
    normalized,
    normalized,
    cleanPoster,
    cleanPoster,
    cleanBackdrop,
    cleanBackdrop,
    cleanOverview,
    cleanOverview,
    id
  );
  rebuildSearchIndex();
}

function listMovies({ q = '', category = '', sort = 'imported', limit = 40, page = 1, metadata = 'all', year = '', hideAdult = true, userId = 1 }) {
  const where = [];
  const params = [];
  addSearchFilters({ where, params, alias: 'm', type: 'movie', q, category, metadata, year, hideAdult });
  const offset = (page - 1) * limit;

  const order = {
    name: 'm.title COLLATE NOCASE ASC',
    category: 'c.name COLLATE NOCASE ASC, m.title COLLATE NOCASE ASC',
    yearDesc: 'COALESCE(m.release_year, 0) DESC, m.title COLLATE NOCASE ASC',
    yearAsc: 'COALESCE(m.release_year, 9999) ASC, m.title COLLATE NOCASE ASC',
    imported: 'm.imported_at DESC, m.id DESC',
    random: 'RANDOM()'
  }[sort] || 'm.imported_at DESC, m.id DESC';

  const items = db.prepare(`
    SELECT
      m.id, 'movie' AS type, m.title, m.poster_url AS posterUrl, m.imported_at AS importedAt,
      m.backdrop_url AS backdropUrl, m.overview, m.release_year AS releaseYear, m.tmdb_id AS tmdbId,
      c.id AS categoryId, c.name AS category,
      EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.content_type = 'movie' AND f.content_id = m.id) AS isFavorite
    FROM movies m
    LEFT JOIN categories c ON c.id = m.category_id
    ${whereClause(where)}
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(userId, ...params, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM movies m
    LEFT JOIN categories c ON c.id = m.category_id
    ${whereClause(where)}
  `).get(...params).total;

  return { items, pagination: paginationMeta(total, page, limit) };
}

function listSeries({ q = '', category = '', sort = 'imported', limit = 40, page = 1, metadata = 'all', year = '', hideAdult = true, userId = 1 }) {
  const where = [];
  const params = [];
  addSearchFilters({ where, params, alias: 's', type: 'series', q, category, metadata, year, hideAdult });
  const offset = (page - 1) * limit;

  const order = {
    name: 's.title COLLATE NOCASE ASC',
    category: 'c.name COLLATE NOCASE ASC, s.title COLLATE NOCASE ASC',
    yearDesc: 'COALESCE(s.first_air_year, 0) DESC, s.title COLLATE NOCASE ASC',
    yearAsc: 'COALESCE(s.first_air_year, 9999) ASC, s.title COLLATE NOCASE ASC',
    imported: 's.imported_at DESC, s.id DESC',
    random: 'RANDOM()'
  }[sort] || 's.imported_at DESC, s.id DESC';

  const items = db.prepare(`
    SELECT
      s.id, 'series' AS type, s.title, s.poster_url AS posterUrl, s.imported_at AS importedAt,
      s.backdrop_url AS backdropUrl, s.overview, s.first_air_year AS firstAirYear, s.tmdb_id AS tmdbId,
      c.id AS categoryId, c.name AS category,
      COUNT(DISTINCT seasons.id) AS seasonCount,
      COUNT(DISTINCT episodes.id) AS episodeCount,
      EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.content_type = 'series' AND f.content_id = s.id) AS isFavorite
    FROM series s
    LEFT JOIN categories c ON c.id = s.category_id
    LEFT JOIN seasons ON seasons.series_id = s.id
    LEFT JOIN episodes ON episodes.series_id = s.id
    ${whereClause(where)}
    GROUP BY s.id
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(userId, ...params, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM series s
    LEFT JOIN categories c ON c.id = s.category_id
    ${whereClause(where)}
  `).get(...params).total;

  return { items, pagination: paginationMeta(total, page, limit) };
}

function listChannels({ q = '', category = '', sort = 'imported', limit = 40, page = 1, hideAdult = true, userId = 1 }) {
  const where = [];
  const params = [];
  addSearchFilters({ where, params, alias: 'ch', type: 'channel', q, category, hideAdult });
  const offset = (page - 1) * limit;

  const order = {
    name: 'ch.title COLLATE NOCASE ASC',
    category: 'c.name COLLATE NOCASE ASC, ch.title COLLATE NOCASE ASC',
    imported: 'ch.imported_at DESC, ch.id DESC',
    random: 'RANDOM()'
  }[sort] || 'ch.imported_at DESC, ch.id DESC';

  const items = db.prepare(`
    SELECT
      ch.id, 'channel' AS type, ch.title, ch.logo_url AS posterUrl, ch.imported_at AS importedAt,
      c.id AS categoryId, c.name AS category,
      EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.content_type = 'channel' AND f.content_id = ch.id) AS isFavorite
    FROM channels ch
    LEFT JOIN categories c ON c.id = ch.category_id
    ${whereClause(where)}
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(userId, ...params, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM channels ch
    LEFT JOIN categories c ON c.id = ch.category_id
    ${whereClause(where)}
  `).get(...params).total;

  return { items: attachCurrentPrograms(items), pagination: paginationMeta(total, page, limit) };
}

function getContinueWatching(userId, mode = 'all', hideAdult = true) {
  const typeFilter = {
    media: "AND content_type IN ('movie', 'episode') AND position > 5 AND completed_at IS NULL",
    channels: "AND content_type = 'channel'",
    all: "AND (content_type = 'channel' OR (position > 5 AND completed_at IS NULL))"
  }[mode] || "AND (content_type = 'channel' OR (position > 5 AND completed_at IS NULL))";

  const progressRows = db.prepare(`
    SELECT *
    FROM watch_progress
    WHERE user_id = ? ${typeFilter}
    ORDER BY updated_at DESC
    LIMIT 20
  `).all(userId);

  const items = [];
  for (const row of progressRows) {
    if (row.content_type === 'movie') {
      const item = db.prepare(`
      SELECT
        movies.id, 'movie' AS type, movies.title, movies.poster_url AS posterUrl, movies.backdrop_url AS backdropUrl,
        c.name AS category,
        EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.content_type = 'movie' AND f.content_id = movies.id) AS isFavorite
        FROM movies
        LEFT JOIN categories c ON c.id = movies.category_id
        WHERE movies.id = ?
      `).get(userId, row.content_id);
      if (hideAdult && isAdultRecord(item)) continue;
      if (item) items.push({ ...item, progress: row });
      continue;
    }

    if (row.content_type === 'episode') {
      const item = db.prepare(`
        SELECT
          e.id, 'episode' AS type, e.title, e.display_title AS displayTitle,
          COALESCE(NULLIF(e.poster_url, ''), NULLIF(se.poster_url, ''), NULLIF(s.poster_url, '')) AS posterUrl,
          s.id AS seriesId, s.title AS seriesTitle, s.backdrop_url AS backdropUrl,
          c.name AS category
        FROM episodes e
        JOIN seasons se ON se.id = e.season_id
        JOIN series s ON s.id = e.series_id
        LEFT JOIN categories c ON c.id = COALESCE(e.category_id, s.category_id)
        WHERE e.id = ?
      `).get(row.content_id);
      if (hideAdult && isAdultRecord({ ...item, title: `${item?.title || ''} ${item?.seriesTitle || ''}` })) continue;
      if (item) items.push({ ...item, progress: row });
      continue;
    }

    if (row.content_type === 'channel') {
      const item = db.prepare(`
        SELECT
          channels.id, 'channel' AS type, channels.title, channels.logo_url AS posterUrl,
          c.name AS category,
          EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.content_type = 'channel' AND f.content_id = channels.id) AS isFavorite
        FROM channels
        LEFT JOIN categories c ON c.id = channels.category_id
        WHERE channels.id = ?
      `).get(userId, row.content_id);
      if (hideAdult && isAdultRecord(item)) continue;
      if (item) items.push({ ...item, progress: row });
    }
  }

  return mode === 'channels' ? attachCurrentPrograms(items) : items;
}

function getUserProfileStats(userId) {
  return {
    progress: db.prepare('SELECT COUNT(*) AS total FROM watch_progress WHERE user_id = ?').get(userId).total,
    watched: db.prepare('SELECT COUNT(*) AS total FROM watch_progress WHERE user_id = ? AND completed_at IS NOT NULL').get(userId).total,
    favorites: db.prepare('SELECT COUNT(*) AS total FROM favorites WHERE user_id = ?').get(userId).total
  };
}

function getRecentProfileItems(userId, hideAdult = true, limit = 18) {
  const rows = db.prepare(`
    SELECT *
    FROM watch_progress
    WHERE user_id = ?
      AND content_type IN ('movie', 'episode')
      AND (position > 5 OR completed_at IS NOT NULL)
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(userId, limit);

  const items = [];
  for (const row of rows) {
    if (row.content_type === 'movie') {
      const item = db.prepare(`
        SELECT
          m.id, 'movie' AS type, m.title, m.poster_url AS posterUrl, m.backdrop_url AS backdropUrl,
          c.name AS category,
          EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.content_type = 'movie' AND f.content_id = m.id) AS isFavorite
        FROM movies m
        LEFT JOIN categories c ON c.id = m.category_id
        WHERE m.id = ?
      `).get(userId, row.content_id);
      if (hideAdult && isAdultRecord(item)) continue;
      if (item) items.push({ ...item, progress: row });
      continue;
    }

    const item = db.prepare(`
      SELECT
        e.id, 'episode' AS type, e.title, e.display_title AS displayTitle,
        COALESCE(NULLIF(e.poster_url, ''), NULLIF(se.poster_url, ''), NULLIF(s.poster_url, '')) AS posterUrl,
        s.id AS seriesId, s.title AS seriesTitle, s.backdrop_url AS backdropUrl,
        c.name AS category
      FROM episodes e
      JOIN seasons se ON se.id = e.season_id
      JOIN series s ON s.id = e.series_id
      LEFT JOIN categories c ON c.id = COALESCE(e.category_id, s.category_id)
      WHERE e.id = ?
    `).get(row.content_id);
    if (hideAdult && isAdultRecord({ ...item, title: `${item?.title || ''} ${item?.seriesTitle || ''}` })) continue;
    if (item) items.push({ ...item, progress: row });
  }

  return items;
}

function getFeaturedItems(hideAdult = true) {
  const movieAdult = hideAdult ? `${adultFilterClauses('m').join(' AND ')} AND` : '';
  const seriesAdult = hideAdult ? `${adultFilterClauses('s').join(' AND ')} AND` : '';
  const items = db.prepare(`
    SELECT *
    FROM (
      SELECT
        m.id, 'movie' AS type, m.title, m.poster_url AS posterUrl,
        m.backdrop_url AS backdropUrl, m.overview, m.imported_at AS importedAt
      FROM movies m
      LEFT JOIN categories c ON c.id = m.category_id
      WHERE ${movieAdult} (m.backdrop_url IS NOT NULL OR m.poster_url IS NOT NULL)

      UNION ALL

      SELECT
        s.id, 'series' AS type, s.title, s.poster_url AS posterUrl,
        s.backdrop_url AS backdropUrl, s.overview, s.imported_at AS importedAt
      FROM series s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE ${seriesAdult} (s.backdrop_url IS NOT NULL OR s.poster_url IS NOT NULL)
    )
    ORDER BY RANDOM()
    LIMIT 5
  `).all();

  if (items.length) return items;

  return db.prepare(`
    SELECT *
    FROM (
      SELECT
        m.id, 'movie' AS type, m.title, m.poster_url AS posterUrl,
        m.backdrop_url AS backdropUrl, m.overview, m.imported_at AS importedAt
      FROM movies m
      LEFT JOIN categories c ON c.id = m.category_id
      ${hideAdult ? `WHERE ${adultFilterClauses('m').join(' AND ')}` : ''}

      UNION ALL

      SELECT
        s.id, 'series' AS type, s.title, s.poster_url AS posterUrl,
        s.backdrop_url AS backdropUrl, s.overview, s.imported_at AS importedAt
      FROM series s
      LEFT JOIN categories c ON c.id = s.category_id
      ${hideAdult ? `WHERE ${adultFilterClauses('s').join(' AND ')}` : ''}
    )
    ORDER BY RANDOM()
    LIMIT 5
  `).all();
}

function getLoginBackgroundItems(limit = 56) {
  return db.prepare(`
    SELECT *
    FROM (
      SELECT
        m.id,
        'movie' AS type,
        m.title,
        COALESCE(NULLIF(m.poster_url, ''), NULLIF(m.backdrop_url, '')) AS imageUrl
      FROM movies m
      LEFT JOIN categories c ON c.id = m.category_id
      WHERE ${adultFilterClauses('m').join(' AND ')}
        AND (m.poster_url IS NOT NULL OR m.backdrop_url IS NOT NULL)
        AND (m.poster_url != '' OR m.backdrop_url != '')

      UNION ALL

      SELECT
        s.id,
        'series' AS type,
        s.title,
        COALESCE(NULLIF(s.poster_url, ''), NULLIF(s.backdrop_url, '')) AS imageUrl
      FROM series s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE ${adultFilterClauses('s').join(' AND ')}
        AND (s.poster_url IS NOT NULL OR s.backdrop_url IS NOT NULL)
        AND (s.poster_url != '' OR s.backdrop_url != '')

    )
    ORDER BY RANDOM()
    LIMIT ?
  `).all(limit);
}

function getCategoryRows(userId = 1, hideAdult = true) {
  const rows = [];
  const categoryAdultClause = hideAdult
    ? `AND c.name NOT LIKE '%Adult%' COLLATE NOCASE AND c.name NOT LIKE '%XXX%' COLLATE NOCASE AND c.name NOT LIKE '%+18%' COLLATE NOCASE`
    : '';
  const movieCategories = db.prepare(`
    SELECT c.id, c.name, COUNT(m.id) AS total, MAX(m.imported_at) AS recent
    FROM categories c
    JOIN movies m ON m.category_id = c.id
    WHERE c.type = 'movie'
      ${categoryAdultClause}
    GROUP BY c.id
    ORDER BY RANDOM()
    LIMIT 5
  `).all();

  for (const category of movieCategories) {
    rows.push({
      title: category.name,
      type: 'movie',
      items: listMovies({ category: category.id, sort: 'random', limit: 18, userId, hideAdult }).items
    });
  }

  const seriesCategories = db.prepare(`
    SELECT c.id, c.name, COUNT(s.id) AS total, MAX(s.imported_at) AS recent
    FROM categories c
    JOIN series s ON s.category_id = c.id
    WHERE c.type = 'series'
      ${categoryAdultClause}
    GROUP BY c.id
    ORDER BY RANDOM()
    LIMIT 4
  `).all();

  for (const category of seriesCategories) {
    rows.push({
      title: `${category.name} - series`,
      type: 'series',
      items: listSeries({ category: category.id, sort: 'random', limit: 18, userId, hideAdult }).items
    });
  }

  return rows;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, stats: getStats() });
});

app.get('/api/auth/login-background', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: getLoginBackgroundItems() });
});

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Usuario ou senha invalidos' });
  }

  return res.json({
    token: signUser(user),
    user: formatUser(user)
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/me/profile', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const formattedUser = formatUser(user);
  const hideAdult = !canShowAdult(formattedUser) || formattedUser.preferHideAdult !== false;
  res.json({
    user: formattedUser,
    stats: getUserProfileStats(formattedUser.id),
    recent: getRecentProfileItems(formattedUser.id, hideAdult)
  });
});

app.patch('/api/me/profile', requireAuth, (req, res) => {
  const displayName = compactInput(req.body.displayName, 80);
  const email = compactInput(req.body.email, 160).toLowerCase();
  const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const preferHideAdult = currentUser.can_view_adult ? boolInput(req.body.preferHideAdult, currentUser.prefer_hide_adult !== 0) : true;
  const autoplayNext = boolInput(req.body.autoplayNext, currentUser.autoplay_next !== 0);

  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Email invalido' });
  }

  db.prepare(`
    UPDATE users SET
      display_name = ?,
      email = ?,
      prefer_hide_adult = ?,
      autoplay_next = ?
    WHERE id = ?
  `).run(displayName, email, preferHideAdult ? 1 : 0, autoplayNext ? 1 : 0, req.user.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: formatUser(user), stats: getUserProfileStats(req.user.id) });
});

app.post('/api/me/avatar', requireAuth, upload.single('image'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Envie uma imagem' });
  if (!String(req.file.mimetype || '').startsWith('image/')) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Arquivo precisa ser imagem' });
  }

  const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
  const avatarsDir = path.join(uploadsDir, 'avatars');
  await fs.promises.mkdir(avatarsDir, { recursive: true });
  const fileName = `user-${req.user.id}-${Date.now()}-${randomUUID()}${ext}`;
  const target = path.join(avatarsDir, fileName);
  await fs.promises.rename(req.file.path, target);
  const url = `/api/uploads/avatars/${fileName}`;
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(url, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ ok: true, url, user: formatUser(user) });
}));

app.put('/api/me/password', requireAuth, (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Senha atual incorreta' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Use uma nova senha com pelo menos 6 caracteres' });
  }

  const passwordHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/me/progress', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM watch_progress WHERE user_id = ?').run(req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({
    ok: true,
    removed: result.changes || 0,
    user: formatUser(user),
    stats: getUserProfileStats(req.user.id),
    recent: []
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ users: listUsers() });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const isAdmin = req.body.isAdmin === true || req.body.isAdmin === 1 || req.body.isAdmin === '1' || req.body.isAdmin === 'true';
  const canViewAdult = req.body.canViewAdult === true || req.body.canViewAdult === 1 || req.body.canViewAdult === '1' || req.body.canViewAdult === 'true';

  if (username.length < 3) {
    return res.status(400).json({ error: 'Use um usuario com pelo menos 3 caracteres' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Use uma senha com pelo menos 6 caracteres' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Esse usuario ja existe' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare('INSERT INTO users (username, password_hash, is_admin, can_view_adult) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, isAdmin ? 1 : 0, canViewAdult ? 1 : 0);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ user: formatUser(user), users: listUsers() });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Usuario invalido' });
  if (userId === req.user.id) return res.status(400).json({ error: 'Voce nao pode remover seu proprio usuario' });

  const user = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });

  if (user.is_admin) {
    const admins = db.prepare('SELECT COUNT(*) AS total FROM users WHERE is_admin = 1').get().total;
    if (admins <= 1) return res.status(400).json({ error: 'Mantenha pelo menos um administrador' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  res.json({ users: listUsers() });
});

app.delete('/api/admin/users/:id/progress', requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) return res.status(400).json({ error: 'Usuario invalido' });

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });

  const result = db.prepare('DELETE FROM watch_progress WHERE user_id = ?').run(userId);
  res.json({ ok: true, removed: result.changes || 0, users: listUsers(), stats: getStats() });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({
    tmdb: getTmdbPublicConfig(),
    omdb: getOmdbPublicConfig(),
    ai: getAiMetadataPublicConfig(),
    epg: getEpgStatus(),
    raw: {
      tmdbLanguage: getSetting('tmdb_language', process.env.TMDB_LANGUAGE || 'pt-BR'),
      aiEnabled: getSetting('ai_metadata_enabled', process.env.AI_METADATA_ENABLED || 'false') === 'true',
      aiBaseUrl: getSetting('ai_metadata_base_url', process.env.AI_METADATA_BASE_URL || 'http://localhost:11434/v1'),
      aiModel: getSetting('ai_metadata_model', process.env.AI_METADATA_MODEL || '')
    }
  });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const apiKey = String(req.body.tmdbApiKey || '').trim();
  const accessToken = String(req.body.tmdbAccessToken || '').trim();
  const omdbApiKey = String(req.body.omdbApiKey || '').trim();

  if (apiKey) {
    setSetting('tmdb_api_key', apiKey);
  }
  if (accessToken) {
    setSetting('tmdb_access_token', accessToken);
  }
  if (omdbApiKey) {
    setSetting('omdb_api_key', omdbApiKey);
  }
  if (Object.hasOwn(req.body, 'tmdbLanguage')) {
    setSetting('tmdb_language', String(req.body.tmdbLanguage || 'pt-BR').trim() || 'pt-BR');
  }
  if (Object.hasOwn(req.body, 'aiEnabled')) {
    setSetting('ai_metadata_enabled', req.body.aiEnabled ? 'true' : 'false');
  }
  if (Object.hasOwn(req.body, 'aiBaseUrl')) {
    setSetting('ai_metadata_base_url', String(req.body.aiBaseUrl || '').trim() || 'http://localhost:11434/v1');
  }
  if (Object.hasOwn(req.body, 'aiModel')) {
    setSetting('ai_metadata_model', String(req.body.aiModel || '').trim());
  }
  if (Object.hasOwn(req.body, 'aiApiKey')) {
    const aiApiKey = String(req.body.aiApiKey || '').trim();
    if (aiApiKey) setSetting('ai_metadata_api_key', aiApiKey);
  }

  res.json({ tmdb: getTmdbPublicConfig(), omdb: getOmdbPublicConfig(), ai: getAiMetadataPublicConfig() });
});

app.get('/api/epg/status', requireAdmin, (req, res) => {
  res.json({ epg: getEpgStatus() });
});

app.post('/api/epg/import', requireAdmin, (req, res) => {
  try {
    const job = queueEpgImport({
      url: String(req.body.url || '').trim(),
      content: String(req.body.content || '').trim()
    });
    res.status(202).json({ jobId: job.id, job });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/epg/import/:id', requireAdmin, (req, res) => {
  const job = getEpgJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Importacao EPG nao encontrada' });
  res.json({ job });
});

app.post('/api/epg/iptv-org', requireAdmin, (req, res) => {
  try {
    const job = queueIptvOrgEpgImport();
    res.status(202).json({ jobId: job.id, job });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/epg/iptv-org/:id', requireAdmin, (req, res) => {
  const job = getIptvOrgEpgJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Importacao iptv-org nao encontrada' });
  res.json({ job });
});

app.post('/api/tmdb/enrich', requireAdmin, (req, res) => {
  try {
    const job = queueTmdbEnrichment({
      limit: req.body.limit,
      runAll: req.body.runAll,
      force: req.body.force,
      includeEpisodes: req.body.includeEpisodes
    });
    res.status(202).json({ jobId: job.id, job });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/tmdb/enrich/active', requireAdmin, (req, res) => {
  res.json({ job: getActiveEnrichJob() });
});

app.get('/api/tmdb/enrich/:id', requireAdmin, (req, res) => {
  const job = getEnrichJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Atualizacao nao encontrada' });
  res.json({ job });
});

app.patch('/api/tmdb/enrich/:id', requireAdmin, (req, res) => {
  const job = updateEnrichJob(req.params.id, String(req.body.action || ''));
  if (!job) return res.status(404).json({ error: 'Atualizacao nao encontrada' });
  res.json({ job });
});

app.post('/api/ai/metadata/run', requireAdmin, (req, res) => {
  try {
    const job = queueAiMetadataAssistant({
      limit: req.body.limit,
      runAll: req.body.runAll,
      generateSynopsis: req.body.generateSynopsis,
      includeEpisodes: req.body.includeEpisodes,
      retryRecent: req.body.retryRecent
    });
    res.status(202).json({ jobId: job.id, job });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/ai/metadata/active', requireAdmin, (req, res) => {
  res.json({ job: getActiveAiMetadataJob() });
});

app.get('/api/ai/metadata/:id', requireAdmin, (req, res) => {
  const job = getAiMetadataJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Fila IA nao encontrada' });
  res.json({ job });
});

app.patch('/api/ai/metadata/:id', requireAdmin, (req, res) => {
  const job = updateAiMetadataJob(req.params.id, String(req.body.action || ''));
  if (!job) return res.status(404).json({ error: 'Fila IA nao encontrada' });
  res.json({ job });
});

app.get('/api/tmdb/search', requireAdmin, asyncRoute(async (req, res) => {
  const type = String(req.query.type || 'movie') === 'series' ? 'series' : 'movie';
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ items: [] });
  const items = await searchTmdbCandidates(type, q);
  res.json({ items });
}));

app.post('/api/tmdb/apply', requireAdmin, asyncRoute(async (req, res) => {
  const type = String(req.body.type || '') === 'series' ? 'series' : 'movie';
  const id = Number(req.body.id);
  const reference = parseTmdbReference(req.body.tmdbReference || req.body.tmdbUrl || req.body.tmdbId);
  const tmdbId = Number(req.body.tmdbId) || reference.id;
  const force = req.body.force !== false;
  if (!id || !tmdbId) return res.status(400).json({ error: 'Selecao TMDB invalida' });
  if (reference.type && reference.type !== type) {
    return res.status(400).json({
      error: reference.type === 'series'
        ? 'Esse link TMDB parece ser de serie, mas o item selecionado e filme'
        : 'Esse link TMDB parece ser de filme, mas o item selecionado e serie'
    });
  }

  const seasonNumbers = type === 'series'
    ? db.prepare('SELECT season_number AS seasonNumber FROM seasons WHERE series_id = ? ORDER BY season_number ASC').all(id).map((season) => season.seasonNumber)
    : [];
  const match = await getTmdbById(type, tmdbId, {
    includeEpisodes: type === 'series',
    seasonNumbers
  });
  if (type === 'series') {
    updateSeriesMetadata(id, match, force);
  } else {
    updateMovieMetadata(id, match, force);
  }

  res.json({ ok: true, match });
}));

app.get('/api/admin/media/search', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim();
  const type = String(req.query.type || 'all');
  const limit = parseLimit(req.query.limit, 30, 80);
  res.json({ items: mediaSearch({ q, type, limit }) });
});

app.patch('/api/admin/media/:type/:id', requireAdmin, (req, res) => {
  const type = String(req.params.type || '');
  const id = Number(req.params.id);
  if (!['movie', 'series', 'channel'].includes(type) || !id) {
    return res.status(400).json({ error: 'Item invalido' });
  }

  try {
    updateManualMetadata({
      type,
      id,
      title: req.body.title,
      overview: req.body.overview,
      posterUrl: req.body.posterUrl,
      backdropUrl: req.body.backdropUrl
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/media/:type/:id/image', requireAdmin, upload.single('image'), asyncRoute(async (req, res) => {
  const type = String(req.params.type || '');
  const id = Number(req.params.id);
  if (!['movie', 'series', 'channel'].includes(type) || !id) {
    return res.status(400).json({ error: 'Item invalido' });
  }
  if (!req.file) return res.status(400).json({ error: 'Envie uma imagem' });
  if (!String(req.file.mimetype || '').startsWith('image/')) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Arquivo precisa ser imagem' });
  }

  const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
  const coversDir = path.join(uploadsDir, 'covers');
  await fs.promises.mkdir(coversDir, { recursive: true });
  const fileName = `${type}-${id}-${Date.now()}-${randomUUID()}${ext}`;
  const target = path.join(coversDir, fileName);
  await fs.promises.rename(req.file.path, target);
  const url = `/api/uploads/covers/${fileName}`;
  updateManualMetadata({ type, id, posterUrl: url });
  res.json({ ok: true, url });
}));

app.post('/api/import', requireAdmin, upload.single('file'), asyncRoute(async (req, res) => {
  let filePath = req.file?.path;
  let cleanup = Boolean(req.file);

  if (!filePath && req.body.content) {
    filePath = path.join(uploadsDir, `paste-${Date.now()}-${randomUUID()}.m3u`);
    await fs.promises.writeFile(filePath, String(req.body.content), 'utf8');
    cleanup = true;
  }

  if (!filePath) {
    return res.status(400).json({ error: 'Envie um arquivo M3U ou cole o conteudo da playlist' });
  }

  const job = queueImport(filePath, { cleanup });
  return res.status(202).json({ jobId: job.id, job });
}));

app.get('/api/import/:id', requireAdmin, (req, res) => {
  const job = getImportJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Importacao nao encontrada' });
  return res.json({ job });
});

app.delete('/api/library', requireAdmin, (req, res) => {
  clearLibrary();
  res.json({ ok: true, stats: getStats() });
});

app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

app.get('/api/categories', (req, res) => {
  const user = getLocalUser(req);
  const type = String(req.query.type || '').trim();
  const params = [];
  const where = [];
  if (type && type !== 'all') {
    where.push('type = ?');
    params.push(type);
  }
  if (!canShowAdult(user)) {
    where.push("name NOT LIKE '%Adult%' COLLATE NOCASE");
    where.push("name NOT LIKE '%XXX%' COLLATE NOCASE");
    where.push("name NOT LIKE '%+18%' COLLATE NOCASE");
  }

  const categories = db.prepare(`
    SELECT id, name, type
    FROM categories
    ${whereClause(where)}
    ORDER BY type, name COLLATE NOCASE
  `).all(...params);

  res.json({ categories });
});

app.get('/api/favorites', (req, res) => {
  const user = getLocalUser(req);
  const hideAdult = !canShowAdult(user) || user.preferHideAdult !== false;
  const result = listFavorites(user.id, {
    type: String(req.query.type || 'all'),
    limit: parseLimit(req.query.limit, 60, 120),
    page: parsePage(req.query.page),
    hideAdult
  });
  res.json(result);
});

app.post('/api/favorites', (req, res) => {
  const user = getLocalUser(req);
  const type = normalizeFavoriteType(req.body.type);
  const id = Number(req.body.id);

  if (!type || !id) return res.status(400).json({ error: 'Favorito invalido' });
  if (!contentExists(type, id)) return res.status(404).json({ error: 'Item nao encontrado' });
  if (!canAccessContent(user, type, id)) return res.status(403).json({ error: 'Conteudo restrito para este usuario' });

  db.prepare(`
    INSERT OR IGNORE INTO favorites (user_id, content_type, content_id)
    VALUES (?, ?, ?)
  `).run(user.id, type, id);

  res.json({ ok: true, isFavorite: true });
});

app.delete('/api/favorites/:type/:id', (req, res) => {
  const userId = getLocalUserId(req);
  const type = normalizeFavoriteType(req.params.type);
  const id = Number(req.params.id);

  if (!type || !id) return res.status(400).json({ error: 'Favorito invalido' });

  db.prepare(`
    DELETE FROM favorites
    WHERE user_id = ? AND content_type = ? AND content_id = ?
  `).run(userId, type, id);

  res.json({ ok: true, isFavorite: false });
});

app.get('/api/home', (req, res) => {
  const user = getLocalUser(req);
  const hideAdult = !canShowAdult(user) || user.preferHideAdult !== false;
  const featuredItems = getFeaturedItems(hideAdult);
  res.json({
    featured: featuredItems[0] || null,
    featuredItems,
    continueWatching: getContinueWatching(user.id, 'all', hideAdult),
    continueMoviesSeries: getContinueWatching(user.id, 'media', hideAdult),
    continueChannels: getContinueWatching(user.id, 'channels', hideAdult),
    favorites: listFavorites(user.id, { limit: 20, hideAdult }).items,
    randomMovies: listMovies({ sort: 'random', limit: 20, userId: user.id, hideAdult }).items,
    randomSeries: listSeries({ sort: 'random', limit: 20, userId: user.id, hideAdult }).items,
    liveChannels: listChannels({ sort: 'random', limit: 20, userId: user.id, hideAdult }).items,
    rows: getCategoryRows(user.id, hideAdult),
    stats: getStats()
  });
});

app.get('/api/movies', (req, res) => {
  const user = getLocalUser(req);
  const result = listMovies({
    q: String(req.query.q || ''),
    category: String(req.query.category || ''),
    sort: String(req.query.sort || 'imported'),
    metadata: String(req.query.metadata || 'all'),
    year: String(req.query.year || ''),
    hideAdult: effectiveHideAdult(req, user),
    limit: parseLimit(req.query.limit),
    page: parsePage(req.query.page),
    userId: user.id
  });
  res.json(result);
});

app.get('/api/movies/:id', (req, res) => {
  const user = getLocalUser(req);
  const movie = db.prepare(`
    SELECT
      m.id, 'movie' AS type, m.title, m.stream_url AS streamUrl, m.poster_url AS posterUrl,
      m.backdrop_url AS backdropUrl, m.overview, m.original_title AS originalTitle,
      m.release_year AS releaseYear, m.tmdb_id AS tmdbId, m.imported_at AS importedAt,
      c.id AS categoryId, c.name AS category
    FROM movies m
    LEFT JOIN categories c ON c.id = m.category_id
    WHERE m.id = ?
  `).get(req.params.id);

  if (!movie) return res.status(404).json({ error: 'Filme nao encontrado' });
  if (!canShowAdult(user) && isAdultRecord(movie)) return res.status(403).json({ error: 'Conteudo restrito para este usuario' });
  const sources = getStreamSources('movie', movie.id, movie.streamUrl);
  res.json({ movie: { ...movie, isFavorite: isFavorite(user.id, 'movie', movie.id), sources: publicSources(sources), sourceCount: sources.length } });
});

app.get('/api/series', (req, res) => {
  const user = getLocalUser(req);
  const result = listSeries({
    q: String(req.query.q || ''),
    category: String(req.query.category || ''),
    sort: String(req.query.sort || 'imported'),
    metadata: String(req.query.metadata || 'all'),
    year: String(req.query.year || ''),
    hideAdult: effectiveHideAdult(req, user),
    limit: parseLimit(req.query.limit),
    page: parsePage(req.query.page),
    userId: user.id
  });
  res.json(result);
});

app.get('/api/series/:id', (req, res) => {
  const user = getLocalUser(req);
  const series = db.prepare(`
    SELECT
      s.id, 'series' AS type, s.title, s.poster_url AS posterUrl, s.backdrop_url AS backdropUrl,
      s.overview, s.original_title AS originalTitle, s.first_air_year AS firstAirYear,
      s.tmdb_id AS tmdbId, s.imported_at AS importedAt,
      c.id AS categoryId, c.name AS category
    FROM series s
    LEFT JOIN categories c ON c.id = s.category_id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!series) return res.status(404).json({ error: 'Serie nao encontrada' });
  if (!canShowAdult(user) && isAdultRecord(series)) return res.status(403).json({ error: 'Conteudo restrito para este usuario' });

  const seasons = db.prepare(`
    SELECT id, season_number AS seasonNumber, title, poster_url AS posterUrl
    FROM seasons
    WHERE series_id = ?
    ORDER BY season_number ASC
  `).all(series.id);

  const episodes = db.prepare(`
    SELECT
      e.id, e.season_id AS seasonId, e.season_number AS seasonNumber, e.episode_number AS episodeNumber,
      e.title, e.display_title AS displayTitle,
      COALESCE(NULLIF(e.poster_url, ''), NULLIF(se.poster_url, ''), NULLIF(s.poster_url, '')) AS posterUrl,
      COUNT(ss.id) AS sourceCount,
      MAX(wp.position) AS progressPosition,
      MAX(wp.duration) AS progressDuration,
      MAX(wp.completed_at) AS completedAt
    FROM episodes e
    JOIN seasons se ON se.id = e.season_id
    JOIN series s ON s.id = e.series_id
    LEFT JOIN stream_sources ss ON ss.content_type = 'episode' AND ss.content_id = e.id
    LEFT JOIN watch_progress wp ON wp.user_id = ? AND wp.content_type = 'episode' AND wp.content_id = e.id
    WHERE e.series_id = ?
    GROUP BY e.id
    ORDER BY e.season_number ASC, e.episode_number ASC, e.title COLLATE NOCASE ASC
  `).all(user.id, series.id);

  const bySeason = new Map(seasons.map((season) => [season.id, { ...season, episodes: [] }]));
  for (const episode of episodes) {
    bySeason.get(episode.seasonId)?.episodes.push(episode);
  }

  res.json({ series: { ...series, isFavorite: isFavorite(user.id, 'series', series.id), seasons: [...bySeason.values()] } });
});

app.get('/api/channels', (req, res) => {
  const user = getLocalUser(req);
  const result = listChannels({
    q: String(req.query.q || ''),
    category: String(req.query.category || ''),
    sort: String(req.query.sort || 'imported'),
    hideAdult: effectiveHideAdult(req, user),
    limit: parseLimit(req.query.limit, 60, 200),
    page: parsePage(req.query.page),
    userId: user.id
  });
  res.json(result);
});

app.get('/api/channels/:id/epg', (req, res) => {
  const user = getLocalUser(req);
  const channel = db.prepare(`
    SELECT ch.id, ch.title, c.name AS category
    FROM channels ch
    LEFT JOIN categories c ON c.id = ch.category_id
    WHERE ch.id = ?
  `).get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Canal nao encontrado' });
  if (!canShowAdult(user) && isAdultRecord(channel)) return res.status(403).json({ error: 'Conteudo restrito para este usuario' });

  res.json({
    current: getCurrentProgram(channel.id),
    next: getNextProgram(channel.id),
    guide: getChannelGuide(channel.id, req.query.hours)
  });
});

app.get('/api/search', asyncRoute(async (req, res) => {
  const user = getLocalUser(req);
  const q = String(req.query.q || '').trim();
  const type = String(req.query.type || 'all');
  const category = String(req.query.category || '');
  const metadata = String(req.query.metadata || 'all');
  const year = String(req.query.year || '');
  const hideAdult = effectiveHideAdult(req, user);
  const limit = parseLimit(req.query.limit, 40, 120);
  const page = parsePage(req.query.page);
  const perTypeLimit = page * limit;
  const results = [];

  if (!q) return res.json({ items: [] });
  let total = 0;
  if (type === 'all' || type === 'movie') {
    const result = listMovies({ q, category, metadata, year, hideAdult, limit: perTypeLimit, userId: user.id });
    results.push(...result.items);
    total += result.pagination.total;
  }
  if (type === 'all' || type === 'series') {
    const result = listSeries({ q, category, metadata, year, hideAdult, limit: perTypeLimit, userId: user.id });
    results.push(...result.items);
    total += result.pagination.total;
  }
  if (type === 'all' || type === 'channel') {
    const result = listChannels({ q, category, hideAdult, limit: perTypeLimit, userId: user.id });
    results.push(...result.items);
    total += result.pagination.total;
  }

  const personMatches = await findPersonCreditMatches({ q, type, category, metadata, year, hideAdult, userId: user.id });
  const merged = mergeSearchItems(results, personMatches);
  const start = (page - 1) * limit;
  res.json({
    items: merged.items.slice(start, start + limit),
    pagination: paginationMeta(total + merged.added, page, limit)
  });
}));

app.get('/api/problems', requireAdmin, (req, res) => {
  const limit = parseLimit(req.query.limit, 40, 120);
  const missing = [
    ...db.prepare(`
      SELECT m.id, 'movie' AS type, m.title, m.poster_url AS posterUrl, m.overview, c.name AS category
      FROM movies m
      LEFT JOIN categories c ON c.id = m.category_id
      WHERE m.tmdb_id IS NULL OR m.poster_url IS NULL OR m.poster_url = '' OR m.overview IS NULL OR m.overview = ''
      ORDER BY m.imported_at DESC, m.id DESC
      LIMIT ?
    `).all(Math.ceil(limit / 2)),
    ...db.prepare(`
      SELECT s.id, 'series' AS type, s.title, s.poster_url AS posterUrl, s.overview, c.name AS category
      FROM series s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE s.tmdb_id IS NULL OR s.poster_url IS NULL OR s.poster_url = '' OR s.overview IS NULL OR s.overview = ''
      ORDER BY s.imported_at DESC, s.id DESC
      LIMIT ?
    `).all(Math.floor(limit / 2))
  ];

  const duplicates = db.prepare(`
    SELECT normalized_title AS normalizedTitle, COUNT(*) AS total, GROUP_CONCAT(id) AS ids, GROUP_CONCAT(title, ' | ') AS titles
    FROM movies
    GROUP BY normalized_title
    HAVING COUNT(*) > 1
    ORDER BY total DESC, normalized_title ASC
    LIMIT ?
  `).all(limit);

  const seriesIssues = db.prepare(`
    SELECT
      s.id, 'series' AS type, s.title, s.poster_url AS posterUrl, c.name AS category,
      COUNT(e.id) AS episodeCount, COUNT(DISTINCT se.id) AS seasonCount
    FROM series s
    LEFT JOIN categories c ON c.id = s.category_id
    LEFT JOIN seasons se ON se.series_id = s.id
    LEFT JOIN episodes e ON e.series_id = s.id
    GROUP BY s.id
    HAVING episodeCount <= 1 OR s.title LIKE '%S__E__%' ESCAPE '\\'
    ORDER BY episodeCount ASC, s.title COLLATE NOCASE ASC
    LIMIT ?
  `).all(limit);

  const stats = {
    missing: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM movies WHERE tmdb_id IS NULL OR poster_url IS NULL OR poster_url = '' OR overview IS NULL OR overview = '') +
        (SELECT COUNT(*) FROM series WHERE tmdb_id IS NULL OR poster_url IS NULL OR poster_url = '' OR overview IS NULL OR overview = '') AS total
    `).get().total,
    duplicateTitles: db.prepare(`
      SELECT COUNT(*) AS total FROM (
        SELECT normalized_title FROM movies GROUP BY normalized_title HAVING COUNT(*) > 1
      )
    `).get().total,
    seriesIssues: db.prepare(`
      SELECT COUNT(*) AS total FROM (
        SELECT s.id
        FROM series s
        LEFT JOIN episodes e ON e.series_id = s.id
        GROUP BY s.id
        HAVING COUNT(e.id) <= 1 OR s.title LIKE '%S__E__%' ESCAPE '\\'
      )
    `).get().total
  };

  res.json({ stats, missing, duplicates, seriesIssues });
});

app.get('/api/play/:type/:id', (req, res) => {
  const user = getLocalUser(req);
  const type = req.params.type;
  const id = Number(req.params.id);

  if (type === 'movie') {
    const movie = db.prepare(`
      SELECT m.id, 'movie' AS type, m.title, m.stream_url AS streamUrl, m.poster_url AS posterUrl,
        m.backdrop_url AS backdropUrl, c.name AS category
      FROM movies m
      LEFT JOIN categories c ON c.id = m.category_id
      WHERE m.id = ?
    `).get(id);
    if (!movie) return res.status(404).json({ error: 'Filme nao encontrado' });
    if (!canShowAdult(user) && isAdultRecord(movie)) return res.status(403).json({ error: 'Conteudo restrito para este usuario' });
    const sources = getStreamSources('movie', movie.id, movie.streamUrl);
    const selectedSource = pickStreamSource(sources, req.query.source);
    const streamUrl = selectedSource?.streamUrl || movie.streamUrl;
    return res.json({
      item: {
        ...movie,
        streamUrl,
        streamFormat: streamFormat(streamUrl),
        sources: publicSources(sources),
        activeSourceId: selectedSource?.id || null,
        isFavorite: isFavorite(user.id, 'movie', movie.id)
      }
    });
  }

  if (type === 'channel') {
    const channel = db.prepare(`
      SELECT ch.id, 'channel' AS type, ch.title, ch.stream_url AS streamUrl, ch.logo_url AS posterUrl,
        c.name AS category
      FROM channels ch
      LEFT JOIN categories c ON c.id = ch.category_id
      WHERE ch.id = ?
    `).get(id);
    if (!channel) return res.status(404).json({ error: 'Canal nao encontrado' });
    if (!canShowAdult(user) && isAdultRecord(channel)) return res.status(403).json({ error: 'Conteudo restrito para este usuario' });
    const sources = getStreamSources('channel', channel.id, channel.streamUrl);
    const selectedSource = pickStreamSource(sources, req.query.source);
    const directStreamUrl = selectedSource?.streamUrl || channel.streamUrl;
    const format = streamFormat(directStreamUrl);
    const sourceQuery = selectedSource?.id ? `?source=${selectedSource.id}` : '';
    return res.json({
      item: {
        ...channel,
        directStreamUrl,
        streamUrl: format === 'mpegts' ? `/api/stream/channel/${channel.id}${sourceQuery}` : directStreamUrl,
        streamFormat: format,
        sources: publicSources(sources),
        activeSourceId: selectedSource?.id || null,
        isFavorite: isFavorite(user.id, 'channel', channel.id),
        currentProgram: getCurrentProgram(channel.id),
        nextProgram: getNextProgram(channel.id),
        guide: getChannelGuide(channel.id, 8)
      }
    });
  }

  if (type === 'episode') {
    const episode = db.prepare(`
      SELECT
        e.id, 'episode' AS type, e.title, e.display_title AS displayTitle, e.stream_url AS streamUrl,
        COALESCE(NULLIF(e.poster_url, ''), NULLIF(se.poster_url, ''), NULLIF(s.poster_url, '')) AS posterUrl,
        e.series_id AS seriesId, e.season_number AS seasonNumber,
        e.episode_number AS episodeNumber, s.title AS seriesTitle,
        COALESCE(NULLIF(s.backdrop_url, ''), NULLIF(se.backdrop_url, ''), NULLIF(s.poster_url, '')) AS backdropUrl,
        s.overview AS seriesOverview,
        c.name AS category
      FROM episodes e
      JOIN seasons se ON se.id = e.season_id
      JOIN series s ON s.id = e.series_id
      LEFT JOIN categories c ON c.id = COALESCE(e.category_id, s.category_id)
      WHERE e.id = ?
    `).get(id);
    if (!episode) return res.status(404).json({ error: 'Episodio nao encontrado' });
    if (!canShowAdult(user) && isAdultRecord({ ...episode, title: `${episode.title || ''} ${episode.seriesTitle || ''}` })) {
      return res.status(403).json({ error: 'Conteudo restrito para este usuario' });
    }

    const nextEpisode = db.prepare(`
      SELECT id, title, season_number AS seasonNumber, episode_number AS episodeNumber
      FROM episodes
      WHERE series_id = ?
        AND (season_number > ? OR (season_number = ? AND episode_number > ?))
      ORDER BY season_number ASC, episode_number ASC
      LIMIT 1
    `).get(episode.seriesId, episode.seasonNumber, episode.seasonNumber, episode.episodeNumber);

    const sources = getStreamSources('episode', episode.id, episode.streamUrl);
    const selectedSource = pickStreamSource(sources, req.query.source);
    const streamUrl = selectedSource?.streamUrl || episode.streamUrl;
    return res.json({
      item: {
        ...episode,
        title: episode.displayTitle,
        streamUrl,
        streamFormat: streamFormat(streamUrl),
        sources: publicSources(sources),
        activeSourceId: selectedSource?.id || null,
        nextEpisode
      }
    });
  }

  return res.status(400).json({ error: 'Tipo invalido' });
});

app.get('/api/stream/channel/:id', asyncRoute(async (req, res) => {
  const user = getLocalUser(req);
  const channel = db.prepare(`
    SELECT ch.id, ch.title, ch.stream_url AS streamUrl, c.name AS category
    FROM channels ch
    LEFT JOIN categories c ON c.id = ch.category_id
    WHERE ch.id = ?
  `).get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Canal nao encontrado' });
  if (!canShowAdult(user) && isAdultRecord(channel)) return res.status(403).json({ error: 'Conteudo restrito para este usuario' });
  const sources = getStreamSources('channel', channel.id, channel.streamUrl);
  const selectedSource = pickStreamSource(sources, req.query.source);
  const directStreamUrl = selectedSource?.streamUrl || channel.streamUrl;

  const controller = new AbortController();
  let closed = false;
  req.on('close', () => {
    closed = true;
    controller.abort();
  });

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitForDrain = () => new Promise((resolve) => res.once('drain', resolve));
  let headersSent = false;
  let attempts = 0;

  while (!closed && !res.destroyed) {
    try {
      const upstream = await fetch(directStreamUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
          Accept: '*/*',
          Connection: 'keep-alive'
        }
      });

      if (!upstream.ok || !upstream.body) {
        if (!headersSent) {
          return res.status(502).json({ error: `Stream respondeu ${upstream.status}` });
        }
        attempts += 1;
        await wait(Math.min(1500, 300 + attempts * 200));
        continue;
      }

      if (!headersSent) {
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'no-store, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        headersSent = true;
      }

      attempts = 0;
      const reader = upstream.body.getReader();
      try {
        while (!closed && !res.destroyed) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.byteLength) {
            const canContinue = res.write(Buffer.from(value));
            if (!canContinue) await waitForDrain();
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (error.name === 'AbortError' || error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        break;
      }
      if (!headersSent) {
        return res.status(502).json({ error: 'Nao foi possivel abrir o stream do canal' });
      }
      attempts += 1;
    }

    if (!closed && !res.destroyed) {
      await wait(Math.min(1500, 300 + attempts * 200));
    }
  }

  if (!closed && !res.destroyed) {
    res.end();
  }
}));

app.delete('/api/progress/completed', requireAdmin, (req, res) => {
  const userId = getLocalUserId(req);
  const result = db.prepare(`
    DELETE FROM watch_progress
    WHERE user_id = ? AND completed_at IS NOT NULL
  `).run(userId);
  res.json({ ok: true, removed: result.changes || 0, stats: getStats() });
});

app.get('/api/progress', (req, res) => {
  const userId = getLocalUserId(req);
  const type = String(req.query.type || '');
  const id = Number(req.query.id);
  const progressKey = `${userId}:${type}:${id}`;
  const progress = db.prepare('SELECT * FROM watch_progress WHERE progress_key = ?').get(progressKey);
  res.json({ progress: progress || null });
});

app.post('/api/progress', (req, res) => {
  const userId = getLocalUserId(req);
  const type = String(req.body.type || '');
  const id = Number(req.body.id);
  const position = Math.max(0, Number(req.body.position || 0));
  const duration = Math.max(0, Number(req.body.duration || 0));
  const requestedCompleted = req.body.completed === true;
  const nearEndCompleted = type !== 'channel' && duration > 0 && position >= Math.max(duration - 8, duration * 0.98);
  const completed = type !== 'channel' && (requestedCompleted || nearEndCompleted);
  const clearCompleted = type !== 'channel' && duration > 0 && position < duration * 0.85;

  if (!['movie', 'episode', 'channel'].includes(type) || !id) {
    return res.status(400).json({ error: 'Progresso invalido' });
  }

  const progressKey = `${userId}:${type}:${id}`;
  db.prepare(`
    INSERT INTO watch_progress (
      user_id, progress_key, content_type, content_id, episode_id, position, duration, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') ELSE NULL END, datetime('now'))
    ON CONFLICT(progress_key) DO UPDATE SET
      position = excluded.position,
      duration = excluded.duration,
      completed_at = CASE
        WHEN ? THEN datetime('now')
        WHEN ? THEN NULL
        ELSE watch_progress.completed_at
      END,
      updated_at = datetime('now')
  `).run(
    userId,
    progressKey,
    type,
    id,
    type === 'episode' ? id : null,
    position,
    duration,
    completed ? 1 : 0,
    completed ? 1 : 0,
    clearCompleted ? 1 : 0
  );

  res.json({ ok: true, completed });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: error.message || 'Erro interno' });
});

const distPath = path.join(projectRoot, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(port, () => {
  console.log(`Weblist API em http://localhost:${port}`);
  startAutoTmdbEnrichment();
});
