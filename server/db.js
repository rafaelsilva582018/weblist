import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { cleanCatalogTitle, cleanChannelTitle, extractStreamVariantInfo, formatSourceLabel } from './parser/m3uParser.js';
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
  runLibraryGroupingMigration();
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

const libraryGroupingVersion = '2026-06-04-variant-groups';

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

function pickPreferredValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? null;
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

function mergeChannelVariants() {
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
      c.name AS categoryName,
      (
        SELECT COUNT(*)
        FROM epg_programs ep
        WHERE ep.channel_id = ch.id
      ) AS programCount
    FROM channels ch
    LEFT JOIN categories c ON c.id = ch.category_id
    ORDER BY ch.id ASC
  `).all();

  const groups = new Map();
  for (const row of rows) {
    const key = normalizeTitle(cleanChannelTitle(row.tvgId || row.tvgName || row.title));
    if (!key) continue;
    const bucket = groups.get(key) || [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  const selectSources = db.prepare(`
    SELECT id, label, stream_url AS streamUrl, source_host AS sourceHost, is_primary AS isPrimary
    FROM stream_sources
    WHERE content_type = 'channel' AND content_id = ?
    ORDER BY is_primary DESC, id ASC
  `);
  const insertSource = db.prepare(`
    INSERT OR IGNORE INTO stream_sources (
      content_type, content_id, label, stream_url, source_host, is_primary
    ) VALUES ('channel', ?, ?, ?, ?, ?)
  `);
  const updateSourceLabel = db.prepare(`
    UPDATE stream_sources
    SET label = ?, source_host = COALESCE(NULLIF(?, ''), source_host)
    WHERE id = ?
  `);
  const updateChannel = db.prepare(`
    UPDATE channels
    SET
      title = ?,
      normalized_title = ?,
      tvg_id = COALESCE(NULLIF(?, ''), tvg_id),
      tvg_name = COALESCE(NULLIF(?, ''), tvg_name),
      logo_url = COALESCE(NULLIF(?, ''), logo_url),
      category_id = COALESCE(?, category_id)
    WHERE id = ?
  `);

  let changed = false;

  for (const [key, bucket] of groups.entries()) {
    if (bucket.length <= 1) continue;
    changed = true;

    const canonical = chooseChannelCanonical(bucket);
    const cleanTitle = cleanChannelTitle(canonical.tvgId || canonical.tvgName || canonical.title) || canonical.title;
    const canonicalCategoryId = bucket.find((row) => !/\blegendad/i.test(row.categoryName || ''))?.categoryId ?? canonical.categoryId;

    for (const row of bucket) {
      const hint = compactSpaces(`${row.title || ''} ${row.tvgName || ''}`);
      const label = buildSourceLabelFromText(hint);
      const currentSources = selectSources.all(row.id);

      for (const source of currentSources) {
        const nextLabel = isGenericSourceLabel(source.label) ? label : source.label;
        if (row.id === canonical.id) {
          const nextHost = source.sourceHost || sourceHost(source.streamUrl || row.streamUrl);
          if (nextLabel !== source.label || nextHost) {
            updateSourceLabel.run(nextLabel, nextHost, source.id);
          }
          continue;
        }

        insertSource.run(
          canonical.id,
          nextLabel,
          source.streamUrl,
          source.sourceHost || sourceHost(source.streamUrl),
          0
        );
      }

      insertSource.run(canonical.id, label, row.streamUrl, sourceHost(row.streamUrl), row.id === canonical.id ? 1 : 0);

      if (row.id === canonical.id) continue;

      db.prepare('UPDATE epg_programs SET channel_id = ? WHERE channel_id = ?').run(canonical.id, row.id);
      mergeFavorites('channel', row.id, canonical.id);
      mergeWatchProgress('channel', row.id, canonical.id);
      db.prepare("DELETE FROM stream_sources WHERE content_type = 'channel' AND content_id = ?").run(row.id);
      db.prepare('DELETE FROM channels WHERE id = ?').run(row.id);
    }

    updateChannel.run(
      cleanTitle,
      key,
      pickPreferredValue(canonical.tvgId, ...bucket.map((row) => row.tvgId)) || '',
      cleanChannelTitle(pickPreferredValue(canonical.tvgName, ...bucket.map((row) => row.tvgName), cleanTitle) || cleanTitle),
      pickPreferredValue(canonical.logoUrl, ...bucket.map((row) => row.logoUrl)) || '',
      canonicalCategoryId || null,
      canonical.id
    );
  }

  return changed;
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
      (
        SELECT COUNT(*)
        FROM episodes e
        WHERE e.series_id = s.id
      ) AS episodeCount
    FROM series s
    ORDER BY s.id ASC
  `).all();

  const groups = new Map();
  for (const row of rows) {
    const cleanTitle = cleanCatalogTitle(row.title);
    const key = normalizeTitle(cleanTitle);
    if (!key) continue;
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
      key,
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

function runLibraryGroupingMigration() {
  if (getSetting('library_grouping_version', '') === libraryGroupingVersion) return;

  let changed = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    changed = mergeSeriesAudioVariants() || changed;
    changed = mergeChannelVariants() || changed;
    setSetting('library_grouping_version', libraryGroupingVersion);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  if (changed) {
    rebuildSearchIndex();
  }
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
