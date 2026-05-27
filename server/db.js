import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';

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
  }
}

function migrateColumns() {
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
  db.prepare("UPDATE channels SET tvg_name = title WHERE tvg_name IS NULL OR tvg_name = ''").run();

  seedPrimaryStreamSources();
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

export function ensureDefaultAdmin() {
  const total = db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
  if (total > 0) return;

  const passwordHash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin', passwordHash);
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
