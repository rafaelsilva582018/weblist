import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { clearLibrary, db, ensureSearchIndex, getSetting, getStats, initDatabase, projectRoot, rebuildSearchIndex, setSetting, uploadsDir } from './db.js';
import { getEnrichJob, queueTmdbEnrichment, updateEnrichJob } from './services/enricher.js';
import { attachCurrentPrograms, getChannelGuide, getCurrentProgram, getEpgJob, getEpgStatus, getNextProgram, queueEpgImport } from './services/epg.js';
import { getImportJob, queueImport } from './services/importer.js';
import { getIptvOrgEpgJob, queueIptvOrgEpgImport } from './services/iptvOrgEpg.js';
import { getTmdbById, getTmdbPublicConfig, searchTmdbCandidates, updateMovieMetadata, updateSeriesMetadata } from './services/tmdb.js';
import { normalizeTitle } from './utils/normalize.js';

const app = express();
const port = Number(process.env.PORT || 3333);
const jwtSecret = process.env.JWT_SECRET || 'weblist-local-secret';
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

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function requireAdmin(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: 'Login necessario' });
    req.user = jwt.verify(token, jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: 'Sessao expirada' });
  }
}

function getLocalUserId(req) {
  try {
    const token = getBearerToken(req);
    if (!token) return 1;
    return Number(jwt.verify(token, jwtSecret).sub) || 1;
  } catch {
    return 1;
  }
}

function signUser(user) {
  return jwt.sign({ sub: user.id, username: user.username }, jwtSecret, { expiresIn: '7d' });
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

function shouldHideAdult(value) {
  return !['0', 'false', 'no'].includes(String(value ?? 'true').toLowerCase());
}

function addSearchFilters({ where, params, alias, type, q, category, metadata = 'all', year = '', hideAdult = true }) {
  if (q) {
    const fts = buildFtsQuery(q);
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
    where.push(`COALESCE(c.name, '') NOT LIKE '%Adult%' COLLATE NOCASE`);
    where.push(`COALESCE(c.name, '') NOT LIKE '%XXX%' COLLATE NOCASE`);
    where.push(`${alias}.title NOT LIKE '%[XXX]%' COLLATE NOCASE`);
  }

  if (year && /^\d{4}$/.test(String(year))) {
    const column = type === 'series' ? 'first_air_year' : 'release_year';
    if (type !== 'channel') {
      where.push(`${alias}.${column} = ?`);
      params.push(Number(year));
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

function mediaSearch({ q = '', type = 'all', limit = 30 }) {
  const raw = String(q || '').trim();
  const normalized = normalizeTitle(raw);
  if (!raw) return [];

  const like = `%${raw}%`;
  const normalizedLike = `%${normalized}%`;
  const items = [];

  if (type === 'all' || type === 'movie') {
    items.push(...db.prepare(`
      SELECT
        m.id, 'movie' AS type, m.title, m.poster_url AS posterUrl,
        m.backdrop_url AS backdropUrl, m.overview, c.name AS category
      FROM movies m
      LEFT JOIN categories c ON c.id = m.category_id
      WHERE m.title LIKE ? COLLATE NOCASE OR m.normalized_title LIKE ? COLLATE NOCASE
      ORDER BY m.title COLLATE NOCASE
      LIMIT ?
    `).all(like, normalizedLike, limit));
  }

  if (type === 'all' || type === 'series') {
    items.push(...db.prepare(`
      SELECT
        s.id, 'series' AS type, s.title, s.poster_url AS posterUrl,
        s.backdrop_url AS backdropUrl, s.overview, c.name AS category
      FROM series s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE s.title LIKE ? COLLATE NOCASE OR s.normalized_title LIKE ? COLLATE NOCASE
      ORDER BY s.title COLLATE NOCASE
      LIMIT ?
    `).all(like, normalizedLike, limit));
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

function listMovies({ q = '', category = '', sort = 'imported', limit = 40, page = 1, metadata = 'all', year = '', hideAdult = true }) {
  const where = [];
  const params = [];
  addSearchFilters({ where, params, alias: 'm', type: 'movie', q, category, metadata, year, hideAdult });
  const offset = (page - 1) * limit;

  const order = {
    name: 'm.title COLLATE NOCASE ASC',
    category: 'c.name COLLATE NOCASE ASC, m.title COLLATE NOCASE ASC',
    imported: 'm.imported_at DESC, m.id DESC'
  }[sort] || 'm.imported_at DESC, m.id DESC';

  const items = db.prepare(`
    SELECT
      m.id, 'movie' AS type, m.title, m.poster_url AS posterUrl, m.imported_at AS importedAt,
      m.backdrop_url AS backdropUrl, m.overview, m.release_year AS releaseYear, m.tmdb_id AS tmdbId,
      c.id AS categoryId, c.name AS category
    FROM movies m
    LEFT JOIN categories c ON c.id = m.category_id
    ${whereClause(where)}
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM movies m
    LEFT JOIN categories c ON c.id = m.category_id
    ${whereClause(where)}
  `).get(...params).total;

  return { items, pagination: paginationMeta(total, page, limit) };
}

function listSeries({ q = '', category = '', sort = 'imported', limit = 40, page = 1, metadata = 'all', year = '', hideAdult = true }) {
  const where = [];
  const params = [];
  addSearchFilters({ where, params, alias: 's', type: 'series', q, category, metadata, year, hideAdult });
  const offset = (page - 1) * limit;

  const order = {
    name: 's.title COLLATE NOCASE ASC',
    category: 'c.name COLLATE NOCASE ASC, s.title COLLATE NOCASE ASC',
    imported: 's.imported_at DESC, s.id DESC'
  }[sort] || 's.imported_at DESC, s.id DESC';

  const items = db.prepare(`
    SELECT
      s.id, 'series' AS type, s.title, s.poster_url AS posterUrl, s.imported_at AS importedAt,
      s.backdrop_url AS backdropUrl, s.overview, s.first_air_year AS firstAirYear, s.tmdb_id AS tmdbId,
      c.id AS categoryId, c.name AS category,
      COUNT(DISTINCT seasons.id) AS seasonCount,
      COUNT(episodes.id) AS episodeCount
    FROM series s
    LEFT JOIN categories c ON c.id = s.category_id
    LEFT JOIN seasons ON seasons.series_id = s.id
    LEFT JOIN episodes ON episodes.series_id = s.id
    ${whereClause(where)}
    GROUP BY s.id
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM series s
    LEFT JOIN categories c ON c.id = s.category_id
    ${whereClause(where)}
  `).get(...params).total;

  return { items, pagination: paginationMeta(total, page, limit) };
}

function listChannels({ q = '', category = '', sort = 'imported', limit = 40, page = 1, hideAdult = true }) {
  const where = [];
  const params = [];
  addSearchFilters({ where, params, alias: 'ch', type: 'channel', q, category, hideAdult });
  const offset = (page - 1) * limit;

  const order = {
    name: 'ch.title COLLATE NOCASE ASC',
    category: 'c.name COLLATE NOCASE ASC, ch.title COLLATE NOCASE ASC',
    imported: 'ch.imported_at DESC, ch.id DESC'
  }[sort] || 'ch.imported_at DESC, ch.id DESC';

  const items = db.prepare(`
    SELECT
      ch.id, 'channel' AS type, ch.title, ch.logo_url AS posterUrl, ch.imported_at AS importedAt,
      c.id AS categoryId, c.name AS category
    FROM channels ch
    LEFT JOIN categories c ON c.id = ch.category_id
    ${whereClause(where)}
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM channels ch
    LEFT JOIN categories c ON c.id = ch.category_id
    ${whereClause(where)}
  `).get(...params).total;

  return { items: attachCurrentPrograms(items), pagination: paginationMeta(total, page, limit) };
}

function getContinueWatching(userId) {
  const progressRows = db.prepare(`
    SELECT *
    FROM watch_progress
    WHERE user_id = ? AND position > 5
    ORDER BY updated_at DESC
    LIMIT 20
  `).all(userId);

  const items = [];
  for (const row of progressRows) {
    if (row.content_type === 'movie') {
      const item = db.prepare(`
      SELECT id, 'movie' AS type, title, poster_url AS posterUrl, backdrop_url AS backdropUrl
        FROM movies WHERE id = ?
      `).get(row.content_id);
      if (item) items.push({ ...item, progress: row });
      continue;
    }

    if (row.content_type === 'episode') {
      const item = db.prepare(`
        SELECT
          e.id, 'episode' AS type, e.title, e.display_title AS displayTitle, e.poster_url AS posterUrl,
          s.id AS seriesId, s.title AS seriesTitle, s.backdrop_url AS backdropUrl
        FROM episodes e
        JOIN series s ON s.id = e.series_id
        WHERE e.id = ?
      `).get(row.content_id);
      if (item) items.push({ ...item, progress: row });
      continue;
    }

    if (row.content_type === 'channel') {
      const item = db.prepare(`
        SELECT id, 'channel' AS type, title, logo_url AS posterUrl
        FROM channels WHERE id = ?
      `).get(row.content_id);
      if (item) items.push({ ...item, progress: row });
    }
  }

  return items;
}

function getFeaturedItems() {
  const items = db.prepare(`
    SELECT *
    FROM (
      SELECT
        m.id, 'movie' AS type, m.title, m.poster_url AS posterUrl,
        m.backdrop_url AS backdropUrl, m.overview, m.imported_at AS importedAt
      FROM movies m
      LEFT JOIN categories c ON c.id = m.category_id
      WHERE COALESCE(c.name, '') NOT LIKE '%Adult%' COLLATE NOCASE
        AND COALESCE(c.name, '') NOT LIKE '%XXX%' COLLATE NOCASE
        AND m.title NOT LIKE '%[XXX]%' COLLATE NOCASE
        AND m.title NOT LIKE '%sexo%' COLLATE NOCASE
        AND m.title NOT LIKE '%porn%' COLLATE NOCASE
        AND m.title NOT LIKE '%erot%' COLLATE NOCASE
        AND m.title NOT LIKE '%18+%' COLLATE NOCASE
        AND (m.backdrop_url IS NOT NULL OR m.poster_url IS NOT NULL)

      UNION ALL

      SELECT
        s.id, 'series' AS type, s.title, s.poster_url AS posterUrl,
        s.backdrop_url AS backdropUrl, s.overview, s.imported_at AS importedAt
      FROM series s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE COALESCE(c.name, '') NOT LIKE '%Adult%' COLLATE NOCASE
        AND COALESCE(c.name, '') NOT LIKE '%XXX%' COLLATE NOCASE
        AND s.title NOT LIKE '%[XXX]%' COLLATE NOCASE
        AND s.title NOT LIKE '%sexo%' COLLATE NOCASE
        AND s.title NOT LIKE '%porn%' COLLATE NOCASE
        AND s.title NOT LIKE '%erot%' COLLATE NOCASE
        AND s.title NOT LIKE '%18+%' COLLATE NOCASE
        AND (s.backdrop_url IS NOT NULL OR s.poster_url IS NOT NULL)
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
      WHERE COALESCE(c.name, '') NOT LIKE '%Adult%' COLLATE NOCASE
        AND COALESCE(c.name, '') NOT LIKE '%XXX%' COLLATE NOCASE
        AND m.title NOT LIKE '%[XXX]%' COLLATE NOCASE
        AND m.title NOT LIKE '%sexo%' COLLATE NOCASE
        AND m.title NOT LIKE '%porn%' COLLATE NOCASE
        AND m.title NOT LIKE '%erot%' COLLATE NOCASE
        AND m.title NOT LIKE '%18+%' COLLATE NOCASE

      UNION ALL

      SELECT
        s.id, 'series' AS type, s.title, s.poster_url AS posterUrl,
        s.backdrop_url AS backdropUrl, s.overview, s.imported_at AS importedAt
      FROM series s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE COALESCE(c.name, '') NOT LIKE '%Adult%' COLLATE NOCASE
        AND COALESCE(c.name, '') NOT LIKE '%XXX%' COLLATE NOCASE
        AND s.title NOT LIKE '%[XXX]%' COLLATE NOCASE
        AND s.title NOT LIKE '%sexo%' COLLATE NOCASE
        AND s.title NOT LIKE '%porn%' COLLATE NOCASE
        AND s.title NOT LIKE '%erot%' COLLATE NOCASE
        AND s.title NOT LIKE '%18+%' COLLATE NOCASE
    )
    ORDER BY importedAt DESC, id DESC
    LIMIT 5
  `).all();
}

function getCategoryRows() {
  const rows = [];
  const movieCategories = db.prepare(`
    SELECT c.id, c.name, COUNT(m.id) AS total, MAX(m.imported_at) AS recent
    FROM categories c
    JOIN movies m ON m.category_id = c.id
    WHERE c.type = 'movie'
      AND c.name NOT LIKE '%Adult%' COLLATE NOCASE
      AND c.name NOT LIKE '%XXX%' COLLATE NOCASE
    GROUP BY c.id
    ORDER BY recent DESC
    LIMIT 5
  `).all();

  for (const category of movieCategories) {
    rows.push({
      title: category.name,
      type: 'movie',
      items: listMovies({ category: category.id, sort: 'imported', limit: 18 }).items
    });
  }

  const seriesCategories = db.prepare(`
    SELECT c.id, c.name, COUNT(s.id) AS total, MAX(s.imported_at) AS recent
    FROM categories c
    JOIN series s ON s.category_id = c.id
    WHERE c.type = 'series'
    GROUP BY c.id
    ORDER BY recent DESC
    LIMIT 4
  `).all();

  for (const category of seriesCategories) {
    rows.push({
      title: `${category.name} - series`,
      type: 'series',
      items: listSeries({ category: category.id, sort: 'imported', limit: 18 }).items
    });
  }

  return rows;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, stats: getStats() });
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
    user: { id: user.id, username: user.username }
  });
});

app.get('/api/auth/me', requireAdmin, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({
    tmdb: getTmdbPublicConfig(),
    epg: getEpgStatus(),
    raw: {
      tmdbLanguage: getSetting('tmdb_language', process.env.TMDB_LANGUAGE || 'pt-BR')
    }
  });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const apiKey = String(req.body.tmdbApiKey || '').trim();
  const accessToken = String(req.body.tmdbAccessToken || '').trim();

  if (apiKey) {
    setSetting('tmdb_api_key', apiKey);
  }
  if (accessToken) {
    setSetting('tmdb_access_token', accessToken);
  }
  if (Object.hasOwn(req.body, 'tmdbLanguage')) {
    setSetting('tmdb_language', String(req.body.tmdbLanguage || 'pt-BR').trim() || 'pt-BR');
  }

  res.json({ tmdb: getTmdbPublicConfig() });
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
      force: req.body.force
    });
    res.status(202).json({ jobId: job.id, job });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
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
  const tmdbId = Number(req.body.tmdbId);
  const force = req.body.force !== false;
  if (!id || !tmdbId) return res.status(400).json({ error: 'Selecao TMDB invalida' });

  const match = await getTmdbById(type, tmdbId);
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
  const type = String(req.query.type || '').trim();
  const params = [];
  const where = [];
  if (type && type !== 'all') {
    where.push('type = ?');
    params.push(type);
  }

  const categories = db.prepare(`
    SELECT id, name, type
    FROM categories
    ${whereClause(where)}
    ORDER BY type, name COLLATE NOCASE
  `).all(...params);

  res.json({ categories });
});

app.get('/api/home', (req, res) => {
  const userId = getLocalUserId(req);
  const featuredItems = getFeaturedItems();
  res.json({
    featured: featuredItems[0] || null,
    featuredItems,
    continueWatching: getContinueWatching(userId),
    recentMovies: listMovies({ sort: 'imported', limit: 20 }).items,
    recentSeries: listSeries({ sort: 'imported', limit: 20 }).items,
    liveChannels: listChannels({ sort: 'imported', limit: 20 }).items,
    rows: getCategoryRows(),
    stats: getStats()
  });
});

app.get('/api/movies', (req, res) => {
  const result = listMovies({
    q: String(req.query.q || ''),
    category: String(req.query.category || ''),
    sort: String(req.query.sort || 'imported'),
    metadata: String(req.query.metadata || 'all'),
    year: String(req.query.year || ''),
    hideAdult: shouldHideAdult(req.query.hideAdult),
    limit: parseLimit(req.query.limit),
    page: parsePage(req.query.page)
  });
  res.json(result);
});

app.get('/api/movies/:id', (req, res) => {
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
  res.json({ movie });
});

app.get('/api/series', (req, res) => {
  const result = listSeries({
    q: String(req.query.q || ''),
    category: String(req.query.category || ''),
    sort: String(req.query.sort || 'imported'),
    metadata: String(req.query.metadata || 'all'),
    year: String(req.query.year || ''),
    hideAdult: shouldHideAdult(req.query.hideAdult),
    limit: parseLimit(req.query.limit),
    page: parsePage(req.query.page)
  });
  res.json(result);
});

app.get('/api/series/:id', (req, res) => {
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

  const seasons = db.prepare(`
    SELECT id, season_number AS seasonNumber, title
    FROM seasons
    WHERE series_id = ?
    ORDER BY season_number ASC
  `).all(series.id);

  const episodes = db.prepare(`
    SELECT
      id, season_id AS seasonId, season_number AS seasonNumber, episode_number AS episodeNumber,
      title, display_title AS displayTitle, poster_url AS posterUrl
    FROM episodes
    WHERE series_id = ?
    ORDER BY season_number ASC, episode_number ASC, title COLLATE NOCASE ASC
  `).all(series.id);

  const bySeason = new Map(seasons.map((season) => [season.id, { ...season, episodes: [] }]));
  for (const episode of episodes) {
    bySeason.get(episode.seasonId)?.episodes.push(episode);
  }

  res.json({ series: { ...series, seasons: [...bySeason.values()] } });
});

app.get('/api/channels', (req, res) => {
  const result = listChannels({
    q: String(req.query.q || ''),
    category: String(req.query.category || ''),
    sort: String(req.query.sort || 'imported'),
    hideAdult: shouldHideAdult(req.query.hideAdult),
    limit: parseLimit(req.query.limit, 60, 200),
    page: parsePage(req.query.page)
  });
  res.json(result);
});

app.get('/api/channels/:id/epg', (req, res) => {
  const channel = db.prepare('SELECT id FROM channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Canal nao encontrado' });

  res.json({
    current: getCurrentProgram(channel.id),
    next: getNextProgram(channel.id),
    guide: getChannelGuide(channel.id, req.query.hours)
  });
});

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const type = String(req.query.type || 'all');
  const category = String(req.query.category || '');
  const metadata = String(req.query.metadata || 'all');
  const year = String(req.query.year || '');
  const hideAdult = shouldHideAdult(req.query.hideAdult);
  const limit = parseLimit(req.query.limit, 40, 120);
  const page = parsePage(req.query.page);
  const perTypeLimit = type === 'all' ? Math.ceil(page * limit / 3) : page * limit;
  const results = [];

  if (!q) return res.json({ items: [] });
  let total = 0;
  if (type === 'all' || type === 'movie') {
    const result = listMovies({ q, category, metadata, year, hideAdult, limit: perTypeLimit });
    results.push(...result.items);
    total += result.pagination.total;
  }
  if (type === 'all' || type === 'series') {
    const result = listSeries({ q, category, metadata, year, hideAdult, limit: perTypeLimit });
    results.push(...result.items);
    total += result.pagination.total;
  }
  if (type === 'all' || type === 'channel') {
    const result = listChannels({ q, category, hideAdult, limit: perTypeLimit });
    results.push(...result.items);
    total += result.pagination.total;
  }

  const start = (page - 1) * limit;
  res.json({
    items: results.slice(start, start + limit),
    pagination: paginationMeta(total, page, limit)
  });
});

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
  const type = req.params.type;
  const id = Number(req.params.id);

  if (type === 'movie') {
    const movie = db.prepare(`
      SELECT id, 'movie' AS type, title, stream_url AS streamUrl, poster_url AS posterUrl
        , backdrop_url AS backdropUrl
      FROM movies WHERE id = ?
    `).get(id);
    if (!movie) return res.status(404).json({ error: 'Filme nao encontrado' });
    return res.json({ item: { ...movie, streamFormat: streamFormat(movie.streamUrl) } });
  }

  if (type === 'channel') {
    const channel = db.prepare(`
      SELECT id, 'channel' AS type, title, stream_url AS streamUrl, logo_url AS posterUrl
      FROM channels WHERE id = ?
    `).get(id);
    if (!channel) return res.status(404).json({ error: 'Canal nao encontrado' });
    const format = streamFormat(channel.streamUrl);
    return res.json({
      item: {
        ...channel,
        directStreamUrl: channel.streamUrl,
        streamUrl: format === 'mpegts' ? `/api/stream/channel/${channel.id}` : channel.streamUrl,
        streamFormat: format,
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
        e.poster_url AS posterUrl, e.series_id AS seriesId, e.season_number AS seasonNumber,
        e.episode_number AS episodeNumber, s.title AS seriesTitle, s.backdrop_url AS backdropUrl,
        s.overview AS seriesOverview
      FROM episodes e
      JOIN series s ON s.id = e.series_id
      WHERE e.id = ?
    `).get(id);
    if (!episode) return res.status(404).json({ error: 'Episodio nao encontrado' });

    const nextEpisode = db.prepare(`
      SELECT id, title, season_number AS seasonNumber, episode_number AS episodeNumber
      FROM episodes
      WHERE series_id = ?
        AND (season_number > ? OR (season_number = ? AND episode_number > ?))
      ORDER BY season_number ASC, episode_number ASC
      LIMIT 1
    `).get(episode.seriesId, episode.seasonNumber, episode.seasonNumber, episode.episodeNumber);

    return res.json({ item: { ...episode, title: episode.displayTitle, streamFormat: streamFormat(episode.streamUrl), nextEpisode } });
  }

  return res.status(400).json({ error: 'Tipo invalido' });
});

app.get('/api/stream/channel/:id', asyncRoute(async (req, res) => {
  const channel = db.prepare('SELECT id, title, stream_url AS streamUrl FROM channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Canal nao encontrado' });

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
      const upstream = await fetch(channel.streamUrl, {
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

  if (!['movie', 'episode', 'channel'].includes(type) || !id) {
    return res.status(400).json({ error: 'Progresso invalido' });
  }

  const progressKey = `${userId}:${type}:${id}`;
  db.prepare(`
    INSERT INTO watch_progress (
      user_id, progress_key, content_type, content_id, episode_id, position, duration, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(progress_key) DO UPDATE SET
      position = excluded.position,
      duration = excluded.duration,
      updated_at = datetime('now')
  `).run(userId, progressKey, type, id, type === 'episode' ? id : null, position, duration);

  res.json({ ok: true });
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
});
