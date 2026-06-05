import fs from 'node:fs';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { db, rebuildSearchIndex, setSetting } from '../db.js';
import {
  classifyItem,
  cleanCatalogTitle,
  cleanChannelTitle,
  extractStreamVariantInfo,
  formatSourceLabel,
  isProbablyPlayableUrl,
  parseExtInf,
  parseM3uHeader
} from '../parser/m3uParser.js';
import { compactSpaces, normalizeTitle, padNumber } from '../utils/normalize.js';

const jobs = new Map();

function createEmptyJob(filePath) {
  return {
    id: randomUUID(),
    filePath,
    status: 'queued',
    message: 'Aguardando importacao',
    totalBytes: 0,
    bytesRead: 0,
    processedLines: 0,
    processedItems: 0,
    duplicates: 0,
    errors: 0,
    errorSamples: [],
    imported: {
      movies: 0,
      series: 0,
      seasons: 0,
      episodes: 0,
      channels: 0,
      sources: 0
    },
    epgUrlDetected: '',
    startedAt: null,
    finishedAt: null
  };
}

export function queueImport(filePath, options = {}) {
  const job = createEmptyJob(filePath);
  jobs.set(job.id, job);

  setImmediate(async () => {
    try {
      await importPlaylistFile(job, options);
    } catch (error) {
      job.status = 'error';
      job.message = error.message || 'Falha ao importar playlist';
      job.finishedAt = new Date().toISOString();
    } finally {
      if (options.cleanup) {
        fs.promises.unlink(filePath).catch(() => {});
      }
    }
  });

  return job;
}

export function getImportJob(id) {
  return jobs.get(id) || null;
}

function prepareStatements() {
  return {
    findStream: db.prepare(`
      SELECT 1 FROM movies WHERE stream_url = ?
      UNION ALL SELECT 1 FROM episodes WHERE stream_url = ?
      UNION ALL SELECT 1 FROM channels WHERE stream_url = ?
      UNION ALL SELECT 1 FROM stream_sources WHERE stream_url = ?
      LIMIT 1
    `),
    selectCategory: db.prepare('SELECT id FROM categories WHERE name = ? AND type = ?'),
    insertCategory: db.prepare('INSERT INTO categories (name, type) VALUES (?, ?)'),
    selectSeries: db.prepare('SELECT id, poster_url AS posterUrl FROM series WHERE normalized_title = ?'),
    insertSeries: db.prepare(`
      INSERT INTO series (title, normalized_title, poster_url, category_id)
      VALUES (?, ?, ?, ?)
    `),
    updateSeriesPoster: db.prepare("UPDATE series SET poster_url = ? WHERE id = ? AND (poster_url IS NULL OR poster_url = '')"),
    selectSeason: db.prepare('SELECT id FROM seasons WHERE series_id = ? AND season_number = ?'),
    insertSeason: db.prepare('INSERT INTO seasons (series_id, season_number, title) VALUES (?, ?, ?)'),
    selectEpisodeIdentity: db.prepare(`
      SELECT id, poster_url AS posterUrl
      FROM episodes
      WHERE series_id = ? AND season_number = ? AND episode_number = ?
      ORDER BY id ASC
      LIMIT 1
    `),
    updateEpisodePoster: db.prepare("UPDATE episodes SET poster_url = ? WHERE id = ? AND (poster_url IS NULL OR poster_url = '')"),
    insertEpisode: db.prepare(`
      INSERT INTO episodes (
        series_id, season_id, season_number, episode_number, title, display_title,
        stream_url, poster_url, category_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    selectMovieIdentity: db.prepare(`
      SELECT id, poster_url AS posterUrl
      FROM movies
      WHERE normalized_title = ? AND category_id = ?
      ORDER BY id ASC
      LIMIT 1
    `),
    updateMoviePoster: db.prepare("UPDATE movies SET poster_url = ? WHERE id = ? AND (poster_url IS NULL OR poster_url = '')"),
    insertMovie: db.prepare(`
      INSERT INTO movies (title, normalized_title, stream_url, poster_url, category_id)
      VALUES (?, ?, ?, ?, ?)
    `),
    selectChannelByTvgId: db.prepare(`
      SELECT id, logo_url AS logoUrl, tvg_id AS tvgId, tvg_name AS tvgName
      FROM channels
      WHERE lower(tvg_id) = lower(?)
      ORDER BY id ASC
      LIMIT 1
    `),
    selectChannelIdentity: db.prepare(`
      SELECT id, logo_url AS logoUrl, tvg_id AS tvgId, tvg_name AS tvgName
      FROM channels
      WHERE normalized_title = ? AND category_id = ?
      ORDER BY id ASC
      LIMIT 1
    `),
    updateChannelLogo: db.prepare("UPDATE channels SET logo_url = ? WHERE id = ? AND (logo_url IS NULL OR logo_url = '')"),
    updateChannelTvgId: db.prepare("UPDATE channels SET tvg_id = ? WHERE id = ? AND (tvg_id IS NULL OR tvg_id = '')"),
    updateChannelTvgName: db.prepare("UPDATE channels SET tvg_name = ? WHERE id = ? AND (tvg_name IS NULL OR tvg_name = '')"),
    insertChannel: db.prepare(`
      INSERT INTO channels (title, normalized_title, tvg_id, tvg_name, stream_url, logo_url, category_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    countSources: db.prepare('SELECT COUNT(*) AS total FROM stream_sources WHERE content_type = ? AND content_id = ?'),
    insertSource: db.prepare(`
      INSERT OR IGNORE INTO stream_sources (
        content_type, content_id, label, stream_url, source_host, is_primary
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
  };
}

function getCategoryId(statements, cache, type, name) {
  const categoryName = compactSpaces(name || 'Sem categoria') || 'Sem categoria';
  const cacheKey = `${type}:${categoryName.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const existing = statements.selectCategory.get(categoryName, type);
  if (existing) {
    cache.set(cacheKey, existing.id);
    return existing.id;
  }

  const result = statements.insertCategory.run(categoryName, type);
  const id = Number(result.lastInsertRowid);
  cache.set(cacheKey, id);
  return id;
}

function addError(job, message) {
  job.errors += 1;
  if (job.errorSamples.length < 8) {
    job.errorSamples.push(message);
  }
}

function sourceHost(streamUrl) {
  try {
    return new URL(streamUrl).host.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function buildSourceLabelFromMeta(meta = {}) {
  const attrs = meta.attrs ? Object.values(meta.attrs).join(' ') : '';
  const variant = extractStreamVariantInfo(
    compactSpaces(`${meta.group || ''} ${meta.name || ''} ${meta.rawTitle || ''} ${meta.tvgName || ''} ${attrs}`)
  );
  return formatSourceLabel(variant);
}

function addStreamSource(statements, type, id, streamUrl, label, isPrimary = false) {
  const current = statements.countSources.get(type, id).total;
  const fallbackLabel = `Opcao ${current + 1}`;
  const sourceLabel = compactSpaces(label || fallbackLabel) || fallbackLabel;
  const result = statements.insertSource.run(type, id, sourceLabel, streamUrl, sourceHost(streamUrl), isPrimary ? 1 : 0);
  return result.changes > 0;
}

function normalizeIdentifier(value = '') {
  return compactSpaces(value).toLowerCase();
}

function importItem(meta, url, statements, cache, job) {
  const streamUrl = compactSpaces(url);
  if (!isProbablyPlayableUrl(streamUrl)) {
    addError(job, `URL ignorada: ${streamUrl.slice(0, 100)}`);
    return;
  }

  if (statements.findStream.get(streamUrl, streamUrl, streamUrl, streamUrl)) {
    job.duplicates += 1;
    return;
  }

  const classification = classifyItem(meta, streamUrl);
  const rawTitle = compactSpaces(meta.name || meta.rawTitle || 'Sem titulo');
  const title = classification.type === 'channel' ? rawTitle : cleanCatalogTitle(rawTitle);
  const sourceLabel = buildSourceLabelFromMeta(meta);
  const posterUrl = compactSpaces(meta.logo || '');

  try {
    if (classification.type === 'episode') {
      const categoryId = getCategoryId(statements, cache, 'series', meta.group);
      const seriesTitle = compactSpaces(classification.seriesTitle);
      const normalizedSeries = normalizeTitle(seriesTitle);

      if (!normalizedSeries) {
        addError(job, `Episodio sem serie: ${title}`);
        return;
      }

      let series = statements.selectSeries.get(normalizedSeries);
      let seriesId;

      if (!series) {
        const result = statements.insertSeries.run(seriesTitle, normalizedSeries, posterUrl || null, categoryId);
        seriesId = Number(result.lastInsertRowid);
        job.imported.series += 1;
      } else {
        seriesId = series.id;
        if (posterUrl && !series.posterUrl) {
          statements.updateSeriesPoster.run(posterUrl, seriesId);
        }
      }

      let season = statements.selectSeason.get(seriesId, classification.season);
      let seasonId;
      if (!season) {
        const result = statements.insertSeason.run(
          seriesId,
          classification.season,
          `Temporada ${classification.season}`
        );
        seasonId = Number(result.lastInsertRowid);
        job.imported.seasons += 1;
      } else {
        seasonId = season.id;
      }

      const episodeTitle = classification.episodeTitle || `Episodio ${classification.episode}`;
      const displayTitle = `${seriesTitle} S${padNumber(classification.season)}E${padNumber(classification.episode)} - ${episodeTitle}`;
      const existingEpisode = statements.selectEpisodeIdentity.get(
        seriesId,
        classification.season,
        classification.episode
      );

      if (existingEpisode) {
        if (posterUrl && !existingEpisode.posterUrl) {
          statements.updateEpisodePoster.run(posterUrl, existingEpisode.id);
        }
        if (addStreamSource(statements, 'episode', existingEpisode.id, streamUrl, sourceLabel)) {
          job.imported.sources += 1;
        } else {
          job.duplicates += 1;
        }
        return;
      }

      const result = statements.insertEpisode.run(
        seriesId,
        seasonId,
        classification.season,
        classification.episode,
        episodeTitle,
        displayTitle,
        streamUrl,
        posterUrl || null,
        categoryId
      );
      addStreamSource(statements, 'episode', Number(result.lastInsertRowid), streamUrl, sourceLabel, true);
      job.imported.episodes += 1;
      return;
    }

    if (classification.type === 'channel') {
      const categoryId = getCategoryId(statements, cache, 'channel', meta.group);
      const channelTitle = cleanChannelTitle(rawTitle) || rawTitle;
      const normalizedChannel = normalizeTitle(channelTitle);
      const channelTvgId = compactSpaces(meta.tvgId || meta.attrs?.['tvg-id'] || '');
      const channelTvgName = cleanChannelTitle(meta.tvgName || meta.name || channelTitle) || channelTitle;

      let existingChannel = channelTvgId
        ? statements.selectChannelByTvgId.get(channelTvgId)
        : null;

      if (!existingChannel) {
        existingChannel = statements.selectChannelIdentity.get(normalizedChannel, categoryId);
        if (
          existingChannel?.tvgId &&
          channelTvgId &&
          normalizeIdentifier(existingChannel.tvgId) !== normalizeIdentifier(channelTvgId)
        ) {
          existingChannel = null;
        }
      }

      if (existingChannel) {
        if (posterUrl && !existingChannel.logoUrl) {
          statements.updateChannelLogo.run(posterUrl, existingChannel.id);
        }
        if (channelTvgId && !existingChannel.tvgId) {
          statements.updateChannelTvgId.run(channelTvgId, existingChannel.id);
        }
        if (channelTvgName && !existingChannel.tvgName) {
          statements.updateChannelTvgName.run(channelTvgName, existingChannel.id);
        }
        if (addStreamSource(statements, 'channel', existingChannel.id, streamUrl, sourceLabel)) {
          job.imported.sources += 1;
        } else {
          job.duplicates += 1;
        }
        return;
      }

      const result = statements.insertChannel.run(
        channelTitle,
        normalizedChannel,
        channelTvgId,
        channelTvgName,
        streamUrl,
        posterUrl || null,
        categoryId
      );
      addStreamSource(statements, 'channel', Number(result.lastInsertRowid), streamUrl, sourceLabel, true);
      job.imported.channels += 1;
      return;
    }

    const categoryId = getCategoryId(statements, cache, 'movie', meta.group);
    const normalizedMovie = normalizeTitle(title);
    const existingMovie = statements.selectMovieIdentity.get(normalizedMovie, categoryId);
    if (existingMovie) {
      if (posterUrl && !existingMovie.posterUrl) {
        statements.updateMoviePoster.run(posterUrl, existingMovie.id);
      }
      if (addStreamSource(statements, 'movie', existingMovie.id, streamUrl, sourceLabel)) {
        job.imported.sources += 1;
      } else {
        job.duplicates += 1;
      }
      return;
    }

    const result = statements.insertMovie.run(title, normalizedMovie, streamUrl, posterUrl || null, categoryId);
    addStreamSource(statements, 'movie', Number(result.lastInsertRowid), streamUrl, sourceLabel, true);
    job.imported.movies += 1;
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      job.duplicates += 1;
      return;
    }
    addError(job, `${title}: ${error.message}`);
  }
}

async function importPlaylistFile(job) {
  if (!fs.existsSync(job.filePath)) {
    throw new Error('Arquivo da playlist nao encontrado');
  }

  job.status = 'running';
  job.message = 'Importando playlist';
  job.startedAt = new Date().toISOString();
  job.totalBytes = fs.statSync(job.filePath).size;

  const statements = prepareStatements();
  const categoryCache = new Map();
  const stream = fs.createReadStream(job.filePath, { encoding: 'utf8' });
  stream.on('data', (chunk) => {
    job.bytesRead += Buffer.byteLength(chunk, 'utf8');
  });

  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let pendingInfo = null;
  let batch = 0;
  let transactionOpen = false;

  db.exec('BEGIN IMMEDIATE');
  transactionOpen = true;

  try {
    for await (const rawLine of reader) {
      job.processedLines += 1;
      const line = rawLine.trim();

      if (!line) continue;
      if (line.toUpperCase().startsWith('#EXTM3U')) {
        const header = parseM3uHeader(line);
        const epgUrl = compactSpaces(header['x-tvg-url'] || header['url-tvg'] || header['epg-url'] || '');
        if (epgUrl) {
          job.epgUrlDetected = epgUrl;
          setSetting('epg_url', epgUrl);
        }
        continue;
      }
      if (line.toUpperCase().startsWith('#EXTINF')) {
        pendingInfo = parseExtInf(line);
        continue;
      }

      if (pendingInfo && !line.startsWith('#')) {
        importItem(pendingInfo, line, statements, categoryCache, job);
        job.processedItems += 1;
        pendingInfo = null;
        batch += 1;
      }

      if (batch >= 500) {
        db.exec('COMMIT');
        transactionOpen = false;
        batch = 0;
        await new Promise((resolve) => setImmediate(resolve));
        db.exec('BEGIN IMMEDIATE');
        transactionOpen = true;
      }
    }

    if (transactionOpen) {
      db.exec('COMMIT');
      transactionOpen = false;
    }

    job.status = 'done';
    job.message = 'Importacao concluida';
    job.bytesRead = job.totalBytes;
    job.finishedAt = new Date().toISOString();
    rebuildSearchIndex();
  } catch (error) {
    if (transactionOpen) {
      db.exec('ROLLBACK');
    }
    throw error;
  }
}
