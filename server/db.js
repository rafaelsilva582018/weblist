import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { cleanCatalogTitle, cleanChannelTitle, extractStreamVariantInfo, formatSourceLabel, isLikelyLiveStreamUrl, parseEpisodeInfo } from './parser/m3uParser.js';
import { isAdultText } from './utils/adult.js';
import { compactSpaces, normalizeTitle, padNumber } from './utils/normalize.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(serverDir, '..');
export const dataDir = path.join(serverDir, 'data');
export const uploadsDir = path.join(serverDir, 'uploads');
export const dbPath = path.join(dataDir, 'weblist.sqlite');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
`);

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      can_view_adult INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('movie', 'series', 'channel')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, type)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      stream_url TEXT NOT NULL UNIQUE,
      poster_url TEXT,
      backdrop_url TEXT,
      overview TEXT,
      original_title TEXT,
      release_year INTEGER,
      tmdb_id INTEGER,
      tmdb_score REAL,
      metadata_updated_at TEXT,
      category_id INTEGER,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL UNIQUE,
      poster_url TEXT,
      backdrop_url TEXT,
      overview TEXT,
      original_title TEXT,
      first_air_year INTEGER,
      tmdb_id INTEGER,
      tmdb_score REAL,
      metadata_updated_at TEXT,
      category_id INTEGER,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(series_id, season_number),
      FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id INTEGER NOT NULL,
      season_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL,
      episode_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      display_title TEXT NOT NULL,
      stream_url TEXT NOT NULL UNIQUE,
      poster_url TEXT,
      category_id INTEGER,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
      FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      tvg_id TEXT,
      tvg_name TEXT,
      stream_url TEXT NOT NULL UNIQUE,
      logo_url TEXT,
      category_id INTEGER,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS stream_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_type TEXT NOT NULL CHECK (content_type IN ('movie', 'episode', 'channel')),
      content_id INTEGER NOT NULL,
      label TEXT,
      stream_url TEXT NOT NULL,
      source_host TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(content_type, content_id, stream_url)
    );

    CREATE TABLE IF NOT EXISTS watch_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      progress_key TEXT NOT NULL UNIQUE,
      content_type TEXT NOT NULL CHECK (content_type IN ('movie', 'episode', 'channel')),
      content_id INTEGER NOT NULL,
      episode_id INTEGER,
      position REAL NOT NULL DEFAULT 0,
      duration REAL NOT NULL DEFAULT 0,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content_type TEXT NOT NULL CHECK (content_type IN ('movie', 'series', 'channel')),
      content_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, content_type, content_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS epg_programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      epg_channel TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      description TEXT,
      category TEXT,
      icon_url TEXT,
      start_at TEXT NOT NULL,
      stop_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_movies_title ON movies(normalized_title);
    CREATE INDEX IF NOT EXISTS idx_movies_category ON movies(category_id);
    CREATE INDEX IF NOT EXISTS idx_series_title ON series(normalized_title);
    CREATE INDEX IF NOT EXISTS idx_episodes_order ON episodes(series_id, season_number, episode_number);
    CREATE INDEX IF NOT EXISTS idx_channels_title ON channels(normalized_title);
    CREATE INDEX IF NOT EXISTS idx_stream_sources_content ON stream_sources(content_type, content_id);
    CREATE INDEX IF NOT EXISTS idx_stream_sources_url ON stream_sources(stream_url);
    CREATE INDEX IF NOT EXISTS idx_watch_progress_recent ON watch_progress(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_favorites_user_recent ON favorites(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_epg_channel_time ON epg_programs(channel_id, start_at, stop_at);
    CREATE INDEX IF NOT EXISTS idx_epg_time ON epg_programs(start_at, stop_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      type UNINDEXED,
      content_id UNINDEXED,
      title,
      category,
      normalized
    );
  `);

  migrateColumns();
  ensureDefaultAdmin();
}

function getColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumn(table, name, definition) {
  const columns = getColumns(table);
  if (!columns.has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    return true;
  }
  return false;
}

function migrateColumns() {
  addColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  const addedAdultPermission = addColumn('users', 'can_view_adult', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'display_name', 'TEXT');
  addColumn('users', 'email', 'TEXT');
  addColumn('users', 'avatar_url', 'TEXT');
  addColumn('users', 'prefer_hide_adult', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('users', 'autoplay_next', 'INTEGER NOT NULL DEFAULT 1');

  const adminCount = db.prepare('SELECT COUNT(*) AS total FROM users WHERE is_admin = 1').get().total;
  if (adminCount === 0) {
    db.prepare("UPDATE users SET is_admin = 1 WHERE username = 'admin' COLLATE NOCASE").run();
    const updatedAdminCount = db.prepare('SELECT COUNT(*) AS total FROM users WHERE is_admin = 1').get().total;
    if (updatedAdminCount === 0) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)').run();
    }
  }
  if (addedAdultPermission) {
    db.prepare('UPDATE users SET can_view_adult = 1 WHERE is_admin = 1 AND can_view_adult = 0').run();
  }

  for (const table of ['movies', 'series']) {
    addColumn(table, 'backdrop_url', 'TEXT');
    addColumn(table, 'overview', 'TEXT');
    addColumn(table, 'original_title', 'TEXT');
    addColumn(table, 'tmdb_id', 'INTEGER');
    addColumn(table, 'tmdb_score', 'REAL');
    addColumn(table, 'metadata_updated_at', 'TEXT');
  }

  addColumn('movies', 'release_year', 'INTEGER');
  addColumn('series', 'first_air_year', 'INTEGER');
  addColumn('seasons', 'poster_url', 'TEXT');
  addColumn('seasons', 'backdrop_url', 'TEXT');
  addColumn('channels', 'tvg_id', 'TEXT');
  addColumn('channels', 'tvg_name', 'TEXT');
  addColumn('watch_progress', 'completed_at', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_watch_progress_completed ON watch_progress(completed_at)');
  db.prepare("UPDATE channels SET tvg_name = title WHERE tvg_name IS NULL OR tvg_name = ''").run();

  seedPrimaryStreamSources();
  applyLibraryGroupingMigration();
}

function seedPrimaryStreamSources() {
  db.prepare(`
    INSERT OR IGNORE INTO stream_sources (content_type, content_id, label, stream_url, is_primary)
    SELECT 'movie', id, 'Opcao 1', stream_url, 1
    FROM movies
    WHERE stream_url IS NOT NULL AND stream_url != ''
  `).run();

  db.prepare(`
    INSERT OR IGNORE INTO stream_sources (content_type, content_id, label, stream_url, is_primary)
    SELECT 'episode', id, 'Opcao 1', stream_url, 1
    FROM episodes
    WHERE stream_url IS NOT NULL AND stream_url != ''
  `).run();

  db.prepare(`
    INSERT OR IGNORE INTO stream_sources (content_type, content_id, label, stream_url, is_primary)
    SELECT 'channel', id, 'Opcao 1', stream_url, 1
    FROM channels
    WHERE stream_url IS NOT NULL AND stream_url != ''
  `).run();
}

const libraryGroupingVersion = '2026-06-05-variant-groups-v13';

const explicitLinearChannelCategories = new Set([
  'cine sky',
  'eleven sports',
  'infantis',
  'max',
  'musicas',
  'noticias internacionais',
  'record tv',
  'sbt',
  'sportv',
  'variedades'
]);

const linearChannelBrandPattern = /\b(?:a&e|adult swim|animal planet|band|bandnews|bbc world|canal brasil|cartoon network|cgtn|cine\s*sky|cnn(?: internacional| espanhol)?|combate|comedy central|discovery|disney(?: channel| junior)?|dw news|eleven sports|espn|fashion tv|fifa tv|flograppling|france 24h?|furacao tv|fx|globo(?:news)?|gnt|hbo(?:\s*2| family| mundi| pop| signature| xtreme)?|history|malhacao fast|megapix|mtv(?: live| 00s)?|multishow|music box brazil|nhk world japan|nick(?:elodeon)?|off|paramount|play kids|polishop tv|premiere|prime box brasil|rai italia|record|sbt|sic internacional|sony|space|sportv|star channel|telecine(?: action| cult| fun| pipoca| premium| touch)?|tooncast|top tv|tnt|travel box brazil|tv5 monde|uol tv|universal reality|urban travel|viva|warner)\b/i;

function isGenericSourceLabel(label = '') {
  return /^opcao(?:\s+\d+)?$/i.test(compactSpaces(label));
}

function buildSourceLabelFromText(value = '', fallback = 'Opcao') {
  return formatSourceLabel(extractStreamVariantInfo(value), fallback);
}

function sourceHost(streamUrl = '') {
  try {
    return new URL(streamUrl).host.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function isLikelyVodStreamUrl(streamUrl = '') {
  const url = String(streamUrl || '').toLowerCase();
  return /\/movie\//.test(url) || /\.(mp4|mkv|avi|mov)(?:$|\?)/.test(url);
}

function hasYearToken(value = '') {
  return /\b(19\d{2}|20\d{2})\b/.test(String(value || ''));
}

function isLikelyMovieCategoryName(categoryName = '') {
  return /\b(?:acao|adultos?|animacao|aventura|cinema|comedia|dc|documentarios?|drama|fantasia|ficcao|filmes?|infantil|lancamentos|legendados?|marvel|nacionais|romance|shows?|suspense|terror)\b/.test(
    normalizeTitle(categoryName)
  );
}

function isLikely24HourLiveCategory(categoryName = '') {
  return /\b(?:24h|24 horas)\b/.test(normalizeTitle(categoryName));
}

function channelCategoryNameFromSeries(categoryName = '') {
  const normalized = compactSpaces(categoryName || 'Sem categoria') || 'Sem categoria';
  if (!isLikely24HourLiveCategory(normalized)) return normalized;
  return compactSpaces(
    normalized.replace(/\b(?:series|serie|seriados|novelas|novela|programas)\b/gi, 'Canais')
  ) || 'Canais 24 Horas';
}

function isLikely24HourSeriesPlaceholder(seriesTitle = '', episode = null) {
  if (!episode) return false;
  if (!isLikelyLiveStreamUrl(episode.streamUrl)) return false;
  if (Number(episode.seasonNumber) !== 1 || Number(episode.episodeNumber) !== 1) return false;

  const normalizedSeries = normalizeTitle(cleanCatalogTitle(seriesTitle));
  const normalizedEpisode = normalizeTitle(cleanCatalogTitle(episode.title || episode.displayTitle || ''));
  if (!normalizedSeries || !normalizedEpisode) return false;

  return normalizedSeries === normalizedEpisode;
}

function pickPreferredValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? null;
}

function ensureCategoryId(type, name) {
  const categoryName = compactSpaces(name || 'Sem categoria') || 'Sem categoria';
  const existing = db.prepare('SELECT id FROM categories WHERE name = ? AND type = ?').get(categoryName, type);
  if (existing?.id) return existing.id;
  const result = db.prepare('INSERT INTO categories (name, type) VALUES (?, ?)').run(categoryName, type);
  return Number(result.lastInsertRowid);
}

function displayTitle(seriesTitle, seasonNumber, episodeNumber, episodeTitle) {
  return `${seriesTitle} S${padNumber(seasonNumber)}E${padNumber(episodeNumber)} - ${episodeTitle}`;
}

function mergeFavorites(contentType, fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;

  db.prepare(`
    INSERT OR IGNORE INTO favorites (user_id, content_type, content_id, created_at)
    SELECT user_id, ?, ?, created_at
    FROM favorites
    WHERE content_type = ? AND content_id = ?
  `).run(contentType, toId, contentType, fromId);

  db.prepare('DELETE FROM favorites WHERE content_type = ? AND content_id = ?').run(contentType, fromId);
}

function mergeWatchProgress(contentType, fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;

  const rows = db.prepare(`
    SELECT user_id, position, duration, completed_at AS completedAt, updated_at AS updatedAt
    FROM watch_progress
    WHERE content_type = ? AND content_id = ?
  `).all(contentType, fromId);

  const upsert = db.prepare(`
    INSERT INTO watch_progress (
      user_id, progress_key, content_type, content_id, episode_id, position, duration, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(progress_key) DO UPDATE SET
      position = CASE
        WHEN excluded.updated_at >= watch_progress.updated_at THEN excluded.position
        ELSE watch_progress.position
      END,
      duration = CASE
        WHEN excluded.updated_at >= watch_progress.updated_at THEN excluded.duration
        ELSE watch_progress.duration
      END,
      completed_at = COALESCE(watch_progress.completed_at, excluded.completed_at),
      updated_at = CASE
        WHEN excluded.updated_at >= watch_progress.updated_at THEN excluded.updated_at
        ELSE watch_progress.updated_at
      END
  `);

  for (const row of rows) {
    upsert.run(
      row.user_id,
      `${row.user_id}:${contentType}:${toId}`,
      contentType,
      toId,
      contentType === 'episode' ? toId : null,
      row.position,
      row.duration,
      row.completedAt,
      row.updatedAt || new Date().toISOString()
    );
  }

  db.prepare('DELETE FROM watch_progress WHERE content_type = ? AND content_id = ?').run(contentType, fromId);
}

function moveFavoritesAcrossTypes(fromType, fromId, toType, toId) {
  if (!fromId || !toId) return;

  db.prepare(`
    INSERT OR IGNORE INTO favorites (user_id, content_type, content_id, created_at)
    SELECT user_id, ?, ?, created_at
    FROM favorites
    WHERE content_type = ? AND content_id = ?
  `).run(toType, toId, fromType, fromId);

  db.prepare('DELETE FROM favorites WHERE content_type = ? AND content_id = ?').run(fromType, fromId);
}

function moveWatchProgressAcrossTypes(fromType, fromId, toType, toId) {
  if (!fromId || !toId) return;

  const rows = db.prepare(`
    SELECT user_id, position, duration, completed_at AS completedAt, updated_at AS updatedAt
    FROM watch_progress
    WHERE content_type = ? AND content_id = ?
  `).all(fromType, fromId);

  const upsert = db.prepare(`
    INSERT INTO watch_progress (
      user_id, progress_key, content_type, content_id, episode_id, position, duration, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(progress_key) DO UPDATE SET
      position = CASE
        WHEN excluded.updated_at >= watch_progress.updated_at THEN excluded.position
        ELSE watch_progress.position
      END,
      duration = CASE
        WHEN excluded.updated_at >= watch_progress.updated_at THEN excluded.duration
        ELSE watch_progress.duration
      END,
      completed_at = COALESCE(watch_progress.completed_at, excluded.completed_at),
      updated_at = CASE
        WHEN excluded.updated_at >= watch_progress.updated_at THEN excluded.updated_at
        ELSE watch_progress.updated_at
      END
  `);

  for (const row of rows) {
    upsert.run(
      row.user_id,
      `${row.user_id}:${toType}:${toId}`,
      toType,
      toId,
      toType === 'episode' ? toId : null,
      row.position,
      row.duration,
      row.completedAt,
      row.updatedAt || new Date().toISOString()
    );
  }

  db.prepare('DELETE FROM watch_progress WHERE content_type = ? AND content_id = ?').run(fromType, fromId);
}

function isAdultLibraryRow(row = {}) {
  return isAdultText(row.title, row.categoryName);
}

function isLikelyLinearChannelMovie(row = {}, cleanTitle = cleanChannelTitle(row.title || '')) {
  if (!cleanTitle) return false;
  if (parseEpisodeInfo(cleanTitle)) return false;

  if (isLikelyVodStreamUrl(row.streamUrl)) return false;

  const normalizedCategory = normalizeTitle(row.categoryName || '');
  if (explicitLinearChannelCategories.has(normalizedCategory) || /\bpay per view\b/.test(normalizedCategory)) {
    return true;
  }

  if (row.tmdbId || row.year || row.overview || row.originalTitle || row.backdropUrl) return false;
  if (hasYearToken(cleanTitle)) return false;

  const hint = compactSpaces(`${row.categoryName || ''} ${cleanTitle}`);
  return linearChannelBrandPattern.test(hint);
}

function isLikelyMovieChannelRow(row = {}, cleanTitle = cleanCatalogTitle(row.title || '')) {
  if (!cleanTitle) return false;
  if (parseEpisodeInfo(cleanTitle)) return false;
  if (!isLikelyVodStreamUrl(row.streamUrl)) return false;
  if (hasYearToken(cleanTitle)) return true;
  return isLikelyMovieCategoryName(row.categoryName);
}

function chooseChannelCanonical(rows) {
  const legendPattern = /\b(legendado|legendados|dublado|dublados)\b/i;
  return rows
    .slice()
    .sort((left, right) => {
      const leftScore = (left.tvgId ? 40 : 0)
        + (left.logoUrl ? 12 : 0)
        + (left.programCount ? 8 : 0)
        + (legendPattern.test(left.categoryName || '') ? -6 : 0);
      const rightScore = (right.tvgId ? 40 : 0)
        + (right.logoUrl ? 12 : 0)
        + (right.programCount ? 8 : 0)
        + (legendPattern.test(right.categoryName || '') ? -6 : 0);
      if (leftScore !== rightScore) return rightScore - leftScore;
      return left.id - right.id;
    })[0];
}

function chooseSeriesCanonical(rows) {
  return rows
    .slice()
    .sort((left, right) => {
      const leftScore = (left.tmdbId ? 60 : 0)
        + (left.posterUrl ? 15 : 0)
        + (left.backdropUrl ? 15 : 0)
        + (left.overview ? 12 : 0)
        + (left.year ? 6 : 0)
        + (left.episodeCount || 0);
      const rightScore = (right.tmdbId ? 60 : 0)
        + (right.posterUrl ? 15 : 0)
        + (right.backdropUrl ? 15 : 0)
        + (right.overview ? 12 : 0)
        + (right.year ? 6 : 0)
        + (right.episodeCount || 0);
      if (leftScore !== rightScore) return rightScore - leftScore;
      return left.id - right.id;
    })[0];
}

function chooseMovieCanonical(rows) {
  return rows
    .slice()
    .sort((left, right) => {
      const leftScore = (left.tmdbId ? 60 : 0)
        + (left.posterUrl ? 15 : 0)
        + (left.backdropUrl ? 15 : 0)
        + (left.overview ? 12 : 0)
        + (left.year ? 6 : 0);
      const rightScore = (right.tmdbId ? 60 : 0)
        + (right.posterUrl ? 15 : 0)
        + (right.backdropUrl ? 15 : 0)
        + (right.overview ? 12 : 0)
        + (right.year ? 6 : 0);
      if (leftScore !== rightScore) return rightScore - leftScore;
      return left.id - right.id;
    })[0];
}

function reclassifyMovieChannels() {
  const rows = db.prepare(`
    SELECT
      m.id,
      m.title,
      m.normalized_title AS normalizedTitle,
      m.stream_url AS streamUrl,
      m.poster_url AS posterUrl,
      m.backdrop_url AS backdropUrl,
      m.overview,
      m.original_title AS originalTitle,
      m.release_year AS year,
      m.tmdb_id AS tmdbId,
      m.category_id AS categoryId,
      c.name AS categoryName
    FROM movies m
    LEFT JOIN categories c ON c.id = m.category_id
    ORDER BY m.id ASC
  `).all();

  const selectSources = db.prepare(`
    SELECT id, label, stream_url AS streamUrl, source_host AS sourceHost, is_primary AS isPrimary
    FROM stream_sources
    WHERE content_type = 'movie' AND content_id = ?
    ORDER BY is_primary DESC, id ASC
  `);
  const insertChannel = db.prepare(`
    INSERT OR IGNORE INTO channels (title, normalized_title, tvg_id, tvg_name, stream_url, logo_url, category_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSource = db.prepare(`
    INSERT OR IGNORE INTO stream_sources (
      content_type, content_id, label, stream_url, source_host, is_primary
    ) VALUES ('channel', ?, ?, ?, ?, ?)
  `);

  let changed = false;

  for (const row of rows) {
    const cleanTitle = cleanChannelTitle(row.title) || row.title;
    const normalizedChannel = normalizeTitle(cleanTitle);
    if (!normalizedChannel) continue;
    if (!isLikelyLinearChannelMovie(row, cleanTitle)) continue;

    changed = true;
    const channelCategoryId = ensureCategoryId('channel', row.categoryName || 'Sem categoria');
    const created = insertChannel.run(
      cleanTitle,
      normalizedChannel,
      null,
      cleanTitle,
      row.streamUrl,
      row.posterUrl || null,
      channelCategoryId
    );
    const channelId = Number(created.lastInsertRowid);

    const currentSources = selectSources.all(row.id);
    const fallbackLabel = buildSourceLabelFromText(`${row.title || ''} ${row.categoryName || ''}`, '');

    if (currentSources.length === 0 && row.streamUrl) {
      insertSource.run(
        channelId,
        fallbackLabel || 'Opcao',
        row.streamUrl,
        sourceHost(row.streamUrl),
        1
      );
    }

    for (const source of currentSources) {
      const nextLabel = isGenericSourceLabel(source.label) && fallbackLabel ? fallbackLabel : source.label;
      insertSource.run(
        channelId,
        nextLabel || source.label || 'Opcao',
        source.streamUrl,
        source.sourceHost || sourceHost(source.streamUrl),
        Number(Boolean(source.isPrimary))
      );
    }

    moveFavoritesAcrossTypes('movie', row.id, 'channel', channelId);
    moveWatchProgressAcrossTypes('movie', row.id, 'channel', channelId);
    db.prepare("DELETE FROM stream_sources WHERE content_type = 'movie' AND content_id = ?").run(row.id);
    db.prepare('DELETE FROM movies WHERE id = ?').run(row.id);
  }

  return changed;
}

function reclassifyChannelMovies() {
  const rows = db.prepare(`
    SELECT
      ch.id,
      ch.title,
      ch.normalized_title AS normalizedTitle,
      ch.tvg_id AS tvgId,
      ch.tvg_name AS tvgName,
      ch.stream_url AS streamUrl,
      ch.logo_url AS logoUrl,
      ch.category_id AS categoryId,
      c.name AS categoryName
    FROM channels ch
    LEFT JOIN categories c ON c.id = ch.category_id
    ORDER BY ch.id ASC
  `).all();

  const selectSources = db.prepare(`
    SELECT id, label, stream_url AS streamUrl, source_host AS sourceHost, is_primary AS isPrimary
    FROM stream_sources
    WHERE content_type = 'channel' AND content_id = ?
    ORDER BY is_primary DESC, id ASC
  `);
  const insertMovie = db.prepare(`
    INSERT OR IGNORE INTO movies (title, normalized_title, stream_url, poster_url, category_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  const selectMovieByUrl = db.prepare(`
    SELECT id, poster_url AS posterUrl, category_id AS categoryId
    FROM movies
    WHERE stream_url = ?
  `);
  const updateMovie = db.prepare(`
    UPDATE movies
    SET
      poster_url = CASE
        WHEN (poster_url IS NULL OR poster_url = '') AND ? IS NOT NULL AND ? != '' THEN ?
        ELSE poster_url
      END,
      category_id = COALESCE(category_id, ?)
    WHERE id = ?
  `);
  const insertSource = db.prepare(`
    INSERT OR IGNORE INTO stream_sources (
      content_type, content_id, label, stream_url, source_host, is_primary
    ) VALUES ('movie', ?, ?, ?, ?, ?)
  `);

  let changed = false;

  for (const row of rows) {
    const cleanTitle = cleanCatalogTitle(row.title) || row.title;
    const normalizedMovie = normalizeTitle(cleanTitle);
    if (!normalizedMovie) continue;
    if (!isLikelyMovieChannelRow(row, cleanTitle)) continue;

    changed = true;
    const movieCategoryId = ensureCategoryId('movie', row.categoryName || 'Sem categoria');
    insertMovie.run(
      row.title,
      normalizedMovie,
      row.streamUrl,
      row.logoUrl || null,
      movieCategoryId
    );

    const movie = selectMovieByUrl.get(row.streamUrl);
    if (!movie?.id) continue;

    updateMovie.run(
      row.logoUrl || null,
      row.logoUrl || null,
      row.logoUrl || null,
      movieCategoryId,
      movie.id
    );

    const currentSources = selectSources.all(row.id);
    const fallbackLabel = buildSourceLabelFromText(`${row.title || ''} ${row.categoryName || ''}`, '');

    if (currentSources.length === 0 && row.streamUrl) {
      insertSource.run(
        movie.id,
        fallbackLabel || 'Opcao',
        row.streamUrl,
        sourceHost(row.streamUrl),
        1
      );
    }

    for (const source of currentSources) {
      const nextLabel = isGenericSourceLabel(source.label) && fallbackLabel ? fallbackLabel : source.label;
      insertSource.run(
        movie.id,
        nextLabel || source.label || 'Opcao',
        source.streamUrl,
        source.sourceHost || sourceHost(source.streamUrl),
        Number(Boolean(source.isPrimary))
      );
    }

    moveFavoritesAcrossTypes('channel', row.id, 'movie', movie.id);
    moveWatchProgressAcrossTypes('channel', row.id, 'movie', movie.id);
    db.prepare("DELETE FROM stream_sources WHERE content_type = 'channel' AND content_id = ?").run(row.id);
    db.prepare('DELETE FROM channels WHERE id = ?').run(row.id);
  }

  return changed;
}

function reclassifySeriesChannels() {
  const rows = db.prepare(`
    SELECT
      s.id,
      s.title,
      s.normalized_title AS normalizedTitle,
      s.poster_url AS posterUrl,
      s.category_id AS categoryId,
      c.name AS categoryName
    FROM series s
    LEFT JOIN categories c ON c.id = s.category_id
    ORDER BY s.id ASC
  `).all();

  const selectEpisodes = db.prepare(`
    SELECT
      e.id,
      e.title,
      e.display_title AS displayTitle,
      e.stream_url AS streamUrl,
      e.poster_url AS posterUrl,
      e.season_number AS seasonNumber,
      e.episode_number AS episodeNumber
    FROM episodes e
    WHERE e.series_id = ?
    ORDER BY e.season_number ASC, e.episode_number ASC, e.id ASC
  `);
  const selectEpisodeSources = db.prepare(`
    SELECT id, label, stream_url AS streamUrl, source_host AS sourceHost, is_primary AS isPrimary
    FROM stream_sources
    WHERE content_type = 'episode' AND content_id = ?
    ORDER BY is_primary DESC, id ASC
  `);
  const selectChannelByStream = db.prepare(`
    SELECT id, logo_url AS logoUrl, category_id AS categoryId
    FROM channels
    WHERE stream_url = ?
    LIMIT 1
  `);
  const insertChannel = db.prepare(`
    INSERT OR IGNORE INTO channels (title, normalized_title, tvg_id, tvg_name, stream_url, logo_url, category_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateChannel = db.prepare(`
    UPDATE channels
    SET
      logo_url = CASE
        WHEN (logo_url IS NULL OR logo_url = '') AND ? IS NOT NULL AND ? != '' THEN ?
        ELSE logo_url
      END,
      category_id = COALESCE(category_id, ?)
    WHERE id = ?
  `);
  const insertSource = db.prepare(`
    INSERT OR IGNORE INTO stream_sources (
      content_type, content_id, label, stream_url, source_host, is_primary
    ) VALUES ('channel', ?, ?, ?, ?, ?)
  `);

  let changed = false;

  for (const row of rows) {
    if (!isLikely24HourLiveCategory(row.categoryName)) continue;

    const episodes = selectEpisodes.all(row.id);
    if (!episodes.length) continue;
    const livePlaceholderEpisodes = episodes.filter((episode) => isLikely24HourSeriesPlaceholder(row.title, episode));
    if (!livePlaceholderEpisodes.length) continue;

    const primaryEpisode = livePlaceholderEpisodes[0];
    const channelTitle = cleanChannelTitle(row.title || primaryEpisode.title || primaryEpisode.displayTitle) || row.title;
    const normalizedChannel = normalizeTitle(channelTitle);
    if (!normalizedChannel || !primaryEpisode.streamUrl) continue;

    changed = true;
    const channelCategoryId = ensureCategoryId('channel', channelCategoryNameFromSeries(row.categoryName));

    insertChannel.run(
      channelTitle,
      normalizedChannel,
      null,
      channelTitle,
      primaryEpisode.streamUrl,
      row.posterUrl || primaryEpisode.posterUrl || null,
      channelCategoryId
    );

    const channel = selectChannelByStream.get(primaryEpisode.streamUrl);
    if (!channel?.id) continue;

    updateChannel.run(
      row.posterUrl || primaryEpisode.posterUrl || null,
      row.posterUrl || primaryEpisode.posterUrl || null,
      row.posterUrl || primaryEpisode.posterUrl || null,
      channelCategoryId,
      channel.id
    );

    if (livePlaceholderEpisodes.length === episodes.length) {
      moveFavoritesAcrossTypes('series', row.id, 'channel', channel.id);
    }

    for (const episode of livePlaceholderEpisodes) {
      const fallbackLabel = buildSourceLabelFromText(`${row.title || ''} ${row.categoryName || ''}`, '');
      const currentSources = selectEpisodeSources.all(episode.id);

      if (currentSources.length === 0 && episode.streamUrl) {
        insertSource.run(
          channel.id,
          fallbackLabel || 'Opcao',
          episode.streamUrl,
          sourceHost(episode.streamUrl),
          Number(episode.id === primaryEpisode.id)
        );
      }

      for (const source of currentSources) {
        const nextLabel = isGenericSourceLabel(source.label) && fallbackLabel ? fallbackLabel : source.label;
        insertSource.run(
          channel.id,
          nextLabel || source.label || 'Opcao',
          source.streamUrl,
          source.sourceHost || sourceHost(source.streamUrl),
          Number(Boolean(source.isPrimary) && episode.id === primaryEpisode.id)
        );
      }

      moveWatchProgressAcrossTypes('episode', episode.id, 'channel', channel.id);
      db.prepare("DELETE FROM stream_sources WHERE content_type = 'episode' AND content_id = ?").run(episode.id);
      db.prepare('DELETE FROM episodes WHERE id = ?').run(episode.id);
    }

    if (livePlaceholderEpisodes.length === episodes.length) {
      db.prepare('DELETE FROM seasons WHERE series_id = ?').run(row.id);
      db.prepare('DELETE FROM series WHERE id = ?').run(row.id);
    }
  }

  return changed;
}

function cleanupMisclassified24HourChannels() {
  const rows = db.prepare(`
    SELECT
      ch.id,
      ch.title,
      ch.normalized_title AS normalizedTitle,
      ch.stream_url AS streamUrl,
      c.name AS categoryName
    FROM channels ch
    LEFT JOIN categories c ON c.id = ch.category_id
    ORDER BY ch.id ASC
  `).all();
  const selectSeriesMatch = db.prepare(`
    SELECT
      s.id,
      COUNT(e.id) AS episodeCount
    FROM series s
    LEFT JOIN episodes e ON e.series_id = s.id
    WHERE s.normalized_title = ?
    GROUP BY s.id
    ORDER BY episodeCount DESC, s.id ASC
    LIMIT 1
  `);

  let changed = false;

  for (const row of rows) {
    if (!isLikely24HourLiveCategory(row.categoryName)) continue;
    if (isLikelyLiveStreamUrl(row.streamUrl)) continue;
    if (!row.normalizedTitle) continue;

    const series = selectSeriesMatch.get(row.normalizedTitle);
    if (!series?.id || Number(series.episodeCount) <= 1) continue;

    changed = true;
    moveFavoritesAcrossTypes('channel', row.id, 'series', series.id);
    db.prepare("DELETE FROM watch_progress WHERE content_type = 'channel' AND content_id = ?").run(row.id);
    db.prepare("DELETE FROM stream_sources WHERE content_type = 'channel' AND content_id = ?").run(row.id);
    db.prepare('DELETE FROM epg_programs WHERE channel_id = ?').run(row.id);
    db.prepare('DELETE FROM channels WHERE id = ?').run(row.id);
  }

  return changed;
}

function mergeMovieVariants() {
  const rows = db.prepare(`
    SELECT
      m.id,
      m.title,
      m.normalized_title AS normalizedTitle,
      m.stream_url AS streamUrl,
      m.poster_url AS posterUrl,
      m.backdrop_url AS backdropUrl,
      m.overview,
      m.original_title AS originalTitle,
      m.release_year AS year,
      m.tmdb_id AS tmdbId,
      m.category_id AS categoryId,
      c.name AS categoryName
    FROM movies m
    LEFT JOIN categories c ON c.id = m.category_id
    ORDER BY m.id ASC
  `).all();

  const groups = new Map();
  for (const row of rows) {
    const cleanTitle = cleanCatalogTitle(row.title);
    const normalizedKey = normalizeTitle(cleanTitle);
    if (!normalizedKey) continue;
    const key = `${normalizedKey}|adult:${isAdultLibraryRow(row) ? 1 : 0}|channel:${isLikelyLinearChannelMovie(row, cleanTitle) ? 1 : 0}`;
    const bucket = groups.get(key) || [];
    bucket.push({
      ...row,
      cleanTitle,
      variantInfo: extractStreamVariantInfo(row.title),
      categoryVariantInfo: extractStreamVariantInfo(row.categoryName || '')
    });
    groups.set(key, bucket);
  }

  const selectSources = db.prepare(`
    SELECT id, label, stream_url AS streamUrl, source_host AS sourceHost, is_primary AS isPrimary
    FROM stream_sources
    WHERE content_type = 'movie' AND content_id = ?
    ORDER BY is_primary DESC, id ASC
  `);
  const insertSource = db.prepare(`
    INSERT OR IGNORE INTO stream_sources (
      content_type, content_id, label, stream_url, source_host, is_primary
    ) VALUES ('movie', ?, ?, ?, ?, ?)
  `);
  const updateSourceLabel = db.prepare(`
    UPDATE stream_sources
    SET label = ?, source_host = COALESCE(NULLIF(?, ''), source_host)
    WHERE id = ?
  `);
  const updateMovie = db.prepare(`
    UPDATE movies
    SET
      title = ?,
      normalized_title = ?,
      poster_url = COALESCE(NULLIF(?, ''), poster_url),
      backdrop_url = COALESCE(NULLIF(?, ''), backdrop_url),
      overview = COALESCE(NULLIF(?, ''), overview),
      original_title = COALESCE(NULLIF(?, ''), original_title),
      release_year = COALESCE(?, release_year),
      tmdb_id = COALESCE(?, tmdb_id),
      category_id = COALESCE(?, category_id)
    WHERE id = ?
  `);

  let changed = false;

  for (const [, bucket] of groups.entries()) {
    if (bucket.length <= 1) continue;
    if (!bucket.some((row) => (
      row.variantInfo?.language ||
      row.variantInfo?.quality ||
      row.variantInfo?.codec ||
      row.categoryVariantInfo?.language ||
      row.categoryVariantInfo?.quality ||
      row.categoryVariantInfo?.codec ||
      row.cleanTitle !== row.title
    ))) continue;

    const tmdbIds = new Set(bucket.map((row) => row.tmdbId).filter(Boolean));
    const years = new Set(bucket.map((row) => row.year).filter(Boolean));
    if (tmdbIds.size > 1 || years.size > 1) continue;

    changed = true;
    const canonical = chooseMovieCanonical(bucket);
    const baseTitle = canonical.cleanTitle || cleanCatalogTitle(canonical.title) || canonical.title;

    for (const row of bucket) {
      const label = buildSourceLabelFromText(`${row.title || ''} ${row.categoryName || ''}`, '');
      const currentSources = selectSources.all(row.id);

      for (const source of currentSources) {
        const nextLabel = isGenericSourceLabel(source.label) && label ? label : source.label;
        if (row.id === canonical.id) {
          const nextHost = source.sourceHost || sourceHost(source.streamUrl || row.streamUrl);
          if ((nextLabel && nextLabel !== source.label) || nextHost) {
            updateSourceLabel.run(nextLabel || source.label, nextHost, source.id);
          }
          continue;
        }

        insertSource.run(
          canonical.id,
          nextLabel || source.label || 'Opcao',
          source.streamUrl,
          source.sourceHost || sourceHost(source.streamUrl),
          0
        );
      }

      insertSource.run(
        canonical.id,
        label || 'Opcao',
        row.streamUrl,
        sourceHost(row.streamUrl),
        row.id === canonical.id ? 1 : 0
      );

      if (row.id === canonical.id) continue;

      mergeFavorites('movie', row.id, canonical.id);
      mergeWatchProgress('movie', row.id, canonical.id);
      db.prepare("DELETE FROM stream_sources WHERE content_type = 'movie' AND content_id = ?").run(row.id);
      db.prepare('DELETE FROM movies WHERE id = ?').run(row.id);
    }

    updateMovie.run(
      baseTitle,
      normalizeTitle(baseTitle),
      pickPreferredValue(canonical.posterUrl, ...bucket.map((row) => row.posterUrl)) || '',
      pickPreferredValue(canonical.backdropUrl, ...bucket.map((row) => row.backdropUrl)) || '',
      pickPreferredValue(canonical.overview, ...bucket.map((row) => row.overview)) || '',
      pickPreferredValue(canonical.originalTitle, ...bucket.map((row) => row.originalTitle)) || '',
      pickPreferredValue(canonical.year, ...bucket.map((row) => row.year)) || null,
      pickPreferredValue(canonical.tmdbId, ...bucket.map((row) => row.tmdbId)) || null,
      pickPreferredValue(canonical.categoryId, ...bucket.map((row) => row.categoryId)) || null,
      canonical.id
    );
  }

  return changed;
}

function mergeChannelVariants() {
  return false;
}

function mergeSeriesAudioVariants() {
  const rows = db.prepare(`
    SELECT
      s.id,
      s.title,
      s.normalized_title AS normalizedTitle,
      s.poster_url AS posterUrl,
      s.backdrop_url AS backdropUrl,
      s.overview,
      s.original_title AS originalTitle,
      s.first_air_year AS year,
      s.tmdb_id AS tmdbId,
      s.category_id AS categoryId,
      c.name AS categoryName,
      (
        SELECT COUNT(*)
        FROM episodes e
        WHERE e.series_id = s.id
      ) AS episodeCount
    FROM series s
    LEFT JOIN categories c ON c.id = s.category_id
    ORDER BY s.id ASC
  `).all();

  const groups = new Map();
  for (const row of rows) {
    const cleanTitle = cleanCatalogTitle(row.title);
    const normalizedKey = normalizeTitle(cleanTitle);
    if (!normalizedKey) continue;
    const key = `${normalizedKey}|adult:${isAdultLibraryRow(row) ? 1 : 0}`;
    const bucket = groups.get(key) || [];
    bucket.push({ ...row, cleanTitle, variantInfo: extractStreamVariantInfo(row.title) });
    groups.set(key, bucket);
  }

  const selectSeasons = db.prepare(`
    SELECT id, season_number AS seasonNumber, title, poster_url AS posterUrl, backdrop_url AS backdropUrl
    FROM seasons
    WHERE series_id = ?
    ORDER BY season_number ASC, id ASC
  `);
  const selectEpisodes = db.prepare(`
    SELECT
      id,
      season_id AS seasonId,
      season_number AS seasonNumber,
      episode_number AS episodeNumber,
      title,
      display_title AS displayTitle,
      stream_url AS streamUrl,
      poster_url AS posterUrl,
      category_id AS categoryId
    FROM episodes
    WHERE series_id = ?
    ORDER BY season_number ASC, episode_number ASC, id ASC
  `);
  const selectEpisodeByIdentity = db.prepare(`
    SELECT id, poster_url AS posterUrl
    FROM episodes
    WHERE series_id = ? AND season_number = ? AND episode_number = ?
    ORDER BY id ASC
    LIMIT 1
  `);
  const selectSources = db.prepare(`
    SELECT id, label, stream_url AS streamUrl, source_host AS sourceHost, is_primary AS isPrimary
    FROM stream_sources
    WHERE content_type = 'episode' AND content_id = ?
    ORDER BY is_primary DESC, id ASC
  `);
  const insertSeason = db.prepare(`
    INSERT INTO seasons (series_id, season_number, title, poster_url, backdrop_url)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateSeason = db.prepare(`
    UPDATE seasons
    SET
      title = COALESCE(NULLIF(?, ''), title),
      poster_url = COALESCE(NULLIF(?, ''), poster_url),
      backdrop_url = COALESCE(NULLIF(?, ''), backdrop_url)
    WHERE id = ?
  `);
  const moveEpisode = db.prepare(`
    UPDATE episodes
    SET
      series_id = ?,
      season_id = ?,
      category_id = COALESCE(?, category_id),
      display_title = ?
    WHERE id = ?
  `);
  const updateEpisode = db.prepare(`
    UPDATE episodes
    SET
      title = COALESCE(NULLIF(?, ''), title),
      display_title = ?,
      poster_url = COALESCE(NULLIF(?, ''), poster_url),
      category_id = COALESCE(?, category_id)
    WHERE id = ?
  `);
  const insertSource = db.prepare(`
    INSERT OR IGNORE INTO stream_sources (
      content_type, content_id, label, stream_url, source_host, is_primary
    ) VALUES ('episode', ?, ?, ?, ?, ?)
  `);
  const updateSourceLabel = db.prepare(`
    UPDATE stream_sources
    SET label = ?, source_host = COALESCE(NULLIF(?, ''), source_host)
    WHERE id = ?
  `);
  const updateSeries = db.prepare(`
    UPDATE series
    SET
      title = ?,
      normalized_title = ?,
      poster_url = COALESCE(NULLIF(?, ''), poster_url),
      backdrop_url = COALESCE(NULLIF(?, ''), backdrop_url),
      overview = COALESCE(NULLIF(?, ''), overview),
      original_title = COALESCE(NULLIF(?, ''), original_title),
      first_air_year = COALESCE(?, first_air_year),
      tmdb_id = COALESCE(?, tmdb_id),
      category_id = COALESCE(?, category_id)
    WHERE id = ?
  `);

  let changed = false;

  for (const [key, bucket] of groups.entries()) {
    if (bucket.length <= 1) continue;
    if (!bucket.some((row) => row.variantInfo?.language || row.variantInfo?.quality || row.variantInfo?.codec)) continue;
    changed = true;

    const canonical = chooseSeriesCanonical(bucket);
    const baseTitle = canonical.cleanTitle || cleanCatalogTitle(canonical.title) || canonical.title;
    const canonicalSeasonMap = new Map();

    for (const season of selectSeasons.all(canonical.id)) {
      canonicalSeasonMap.set(Number(season.seasonNumber), season);
    }

    for (const row of bucket) {
      const seriesAudioLabel = buildSourceLabelFromText(row.title, '');
      const seasons = selectSeasons.all(row.id);
      const episodes = selectEpisodes.all(row.id);

      for (const season of seasons) {
        const seasonNumber = Number(season.seasonNumber);
        if (!canonicalSeasonMap.has(seasonNumber)) {
          const result = insertSeason.run(
            canonical.id,
            seasonNumber,
            compactSpaces(season.title || `Temporada ${seasonNumber}`),
            season.posterUrl || null,
            season.backdropUrl || null
          );
          canonicalSeasonMap.set(seasonNumber, {
            id: Number(result.lastInsertRowid),
            seasonNumber,
            title: compactSpaces(season.title || `Temporada ${seasonNumber}`),
            posterUrl: season.posterUrl,
            backdropUrl: season.backdropUrl
          });
        } else if (row.id !== canonical.id) {
          const targetSeason = canonicalSeasonMap.get(seasonNumber);
          updateSeason.run(season.title || '', season.posterUrl || '', season.backdropUrl || '', targetSeason.id);
        }
      }

      for (const episode of episodes) {
        const targetSeason = canonicalSeasonMap.get(Number(episode.seasonNumber));
        const fallbackLabel = seriesAudioLabel || buildSourceLabelFromText(episode.displayTitle, 'Opcao');
        const targetDisplayTitle = displayTitle(baseTitle, episode.seasonNumber, episode.episodeNumber, episode.title);
        const existing = selectEpisodeByIdentity.get(canonical.id, episode.seasonNumber, episode.episodeNumber);
        const currentSources = selectSources.all(episode.id);

        if (existing && existing.id !== episode.id) {
          if (episode.streamUrl) {
            insertSource.run(existing.id, fallbackLabel, episode.streamUrl, '', 0);
          }
          for (const source of currentSources) {
            insertSource.run(
              existing.id,
              isGenericSourceLabel(source.label) ? fallbackLabel : source.label,
              source.streamUrl,
              source.sourceHost || sourceHost(source.streamUrl),
              0
            );
          }
          updateEpisode.run(episode.title || '', targetDisplayTitle, episode.posterUrl || '', episode.categoryId || canonical.categoryId || null, existing.id);
          mergeWatchProgress('episode', episode.id, existing.id);
          db.prepare("DELETE FROM stream_sources WHERE content_type = 'episode' AND content_id = ?").run(episode.id);
          db.prepare('DELETE FROM episodes WHERE id = ?').run(episode.id);
          continue;
        }

        if (row.id === canonical.id && existing?.id === episode.id) {
          for (const source of currentSources) {
            if (isGenericSourceLabel(source.label)) {
              updateSourceLabel.run(fallbackLabel, source.sourceHost || sourceHost(source.streamUrl), source.id);
            }
          }
          updateEpisode.run(episode.title || '', targetDisplayTitle, episode.posterUrl || '', episode.categoryId || canonical.categoryId || null, episode.id);
          continue;
        }

        moveEpisode.run(
          canonical.id,
          targetSeason.id,
          episode.categoryId || canonical.categoryId || null,
          targetDisplayTitle,
          episode.id
        );
        for (const source of currentSources) {
          if (isGenericSourceLabel(source.label)) {
            updateSourceLabel.run(fallbackLabel, source.sourceHost || sourceHost(source.streamUrl), source.id);
          }
        }
      }

      if (row.id === canonical.id) continue;

      mergeFavorites('series', row.id, canonical.id);
      db.prepare('DELETE FROM seasons WHERE series_id = ?').run(row.id);
      db.prepare('DELETE FROM series WHERE id = ?').run(row.id);
    }

    updateSeries.run(
      baseTitle,
      normalizeTitle(baseTitle),
      pickPreferredValue(canonical.posterUrl, ...bucket.map((row) => row.posterUrl)) || '',
      pickPreferredValue(canonical.backdropUrl, ...bucket.map((row) => row.backdropUrl)) || '',
      pickPreferredValue(canonical.overview, ...bucket.map((row) => row.overview)) || '',
      pickPreferredValue(canonical.originalTitle, ...bucket.map((row) => row.originalTitle)) || '',
      pickPreferredValue(canonical.year, ...bucket.map((row) => row.year)) || null,
      pickPreferredValue(canonical.tmdbId, ...bucket.map((row) => row.tmdbId)) || null,
      pickPreferredValue(canonical.categoryId, ...bucket.map((row) => row.categoryId)) || null,
      canonical.id
    );
  }

  return changed;
}

export function applyLibraryGroupingMigration(options = {}) {
  const force = options?.force === true;
  const skipSearchRebuild = options?.skipSearchRebuild === true;
  if (!force && getSetting('library_grouping_version', '') === libraryGroupingVersion) return false;

  let changed = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    changed = cleanupMisclassified24HourChannels() || changed;
    changed = reclassifySeriesChannels() || changed;
    changed = reclassifyChannelMovies() || changed;
    changed = reclassifyMovieChannels() || changed;
    changed = mergeMovieVariants() || changed;
    changed = mergeSeriesAudioVariants() || changed;
    setSetting('library_grouping_version', libraryGroupingVersion);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  if (changed && !skipSearchRebuild) {
    rebuildSearchIndex();
  }

  return changed;
}

export function ensureDefaultAdmin() {
  const total = db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
  if (total > 0) return;

  const passwordHash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password_hash, is_admin, can_view_adult) VALUES (?, ?, 1, 1)').run('admin', passwordHash);
}

export function clearLibrary() {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      DELETE FROM watch_progress;
      DELETE FROM favorites;
      DELETE FROM epg_programs;
      DELETE FROM stream_sources;
      DELETE FROM episodes;
      DELETE FROM seasons;
      DELETE FROM series;
      DELETE FROM movies;
      DELETE FROM channels;
      DELETE FROM categories;
      DELETE FROM search_index;
      DELETE FROM sqlite_sequence WHERE name IN (
        'watch_progress', 'favorites', 'stream_sources', 'episodes', 'seasons', 'series', 'movies', 'channels', 'categories', 'epg_programs'
      );
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getStats() {
  return {
    movies: db.prepare('SELECT COUNT(*) AS total FROM movies').get().total,
    series: db.prepare('SELECT COUNT(*) AS total FROM series').get().total,
    seasons: db.prepare('SELECT COUNT(*) AS total FROM seasons').get().total,
    episodes: db.prepare('SELECT COUNT(*) AS total FROM episodes').get().total,
    channels: db.prepare('SELECT COUNT(*) AS total FROM channels').get().total,
    sources: db.prepare('SELECT COUNT(*) AS total FROM stream_sources').get().total,
    watched: db.prepare('SELECT COUNT(*) AS total FROM watch_progress WHERE completed_at IS NOT NULL').get().total,
    categories: db.prepare('SELECT COUNT(*) AS total FROM categories').get().total
  };
}

export function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? fallback;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

export function rebuildSearchIndex() {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM search_index');
    db.prepare(`
      INSERT INTO search_index (type, content_id, title, category, normalized)
      SELECT 'movie', m.id, m.title, COALESCE(c.name, ''), m.normalized_title
      FROM movies m
      LEFT JOIN categories c ON c.id = m.category_id
    `).run();
    db.prepare(`
      INSERT INTO search_index (type, content_id, title, category, normalized)
      SELECT 'series', s.id, s.title, COALESCE(c.name, ''), s.normalized_title
      FROM series s
      LEFT JOIN categories c ON c.id = s.category_id
    `).run();
    db.prepare(`
      INSERT INTO search_index (type, content_id, title, category, normalized)
      SELECT 'channel', ch.id, ch.title, COALESCE(c.name, ''), ch.normalized_title
      FROM channels ch
      LEFT JOIN categories c ON c.id = ch.category_id
    `).run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function ensureSearchIndex() {
  const indexed = db.prepare('SELECT COUNT(*) AS total FROM search_index').get().total;
  const library = getStats();
  const expected = library.movies + library.series + library.channels;
  if (expected > 0 && indexed === 0) {
    rebuildSearchIndex();
  }
}
