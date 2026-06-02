import { randomUUID } from 'node:crypto';
import { db, getSetting } from '../db.js';
import { extractMetadataTitle } from '../parser/m3uParser.js';
import { compactSpaces, normalizeTitle } from '../utils/normalize.js';
import {
  getTmdbById,
  searchMovieMetadata,
  searchSeriesMetadata,
  updateMovieMetadata,
  updateSeriesMetadata
} from './tmdb.js';

const jobs = new Map();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskSecret(value = '') {
  if (!value) return '';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function getAiMetadataConfig() {
  const baseUrl = getSetting('ai_metadata_base_url', process.env.AI_METADATA_BASE_URL || 'http://localhost:11434/v1');
  const apiKey = getSetting('ai_metadata_api_key', process.env.AI_METADATA_API_KEY || '');
  const model = getSetting('ai_metadata_model', process.env.AI_METADATA_MODEL || '');
  const enabled = toBoolean(getSetting('ai_metadata_enabled', process.env.AI_METADATA_ENABLED || 'false'));
  const temperature = Number(getSetting('ai_metadata_temperature', process.env.AI_METADATA_TEMPERATURE || '0.1'));

  return {
    enabled,
    baseUrl: compactSpaces(baseUrl || '').replace(/\/+$/, ''),
    apiKey,
    model: compactSpaces(model || ''),
    temperature: Number.isFinite(temperature) ? Math.min(Math.max(temperature, 0), 1) : 0.1
  };
}

function requiresApiKey(baseUrl = '') {
  return /api\.openai\.com|openrouter\.ai|openai/i.test(baseUrl) && !/localhost|127\.0\.0\.1/i.test(baseUrl);
}

export function getAiMetadataPublicConfig() {
  const config = getAiMetadataConfig();
  return {
    enabled: config.enabled,
    configured: Boolean(config.enabled && config.baseUrl && config.model && (!requiresApiKey(config.baseUrl) || config.apiKey)),
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyMasked: maskSecret(config.apiKey)
  };
}

function createJob(options) {
  return {
    id: randomUUID(),
    status: 'queued',
    message: 'Aguardando IA',
    processed: 0,
    matched: 0,
    normalized: 0,
    synopsisGenerated: 0,
    episodes: 0,
    review: 0,
    skipped: 0,
    errors: 0,
    errorSamples: [],
    total: 0,
    batch: 0,
    currentTitle: '',
    requestedPause: false,
    requestedStop: false,
    running: false,
    options,
    startedAt: null,
    finishedAt: null
  };
}

export function getAiMetadataJob(id) {
  return jobs.get(id) || null;
}

export function getActiveAiMetadataJob() {
  return [...jobs.values()].find((job) => ['queued', 'running', 'paused'].includes(job.status) && !job.requestedStop) || null;
}

export function updateAiMetadataJob(id, action) {
  const job = getAiMetadataJob(id);
  if (!job) return null;

  if (action === 'pause' && job.status === 'running') {
    job.requestedPause = true;
    job.message = 'Pausando ao final do item atual';
  }

  if (action === 'resume' && job.status === 'paused') {
    job.requestedPause = false;
    job.status = 'running';
    job.message = 'Retomando assistente IA';
    setImmediate(() => runAiMetadataJob(job).catch((error) => {
      job.status = 'error';
      job.message = error.message || 'Falha no assistente IA';
      job.finishedAt = new Date().toISOString();
      job.running = false;
    }));
  }

  if (action === 'stop' && ['queued', 'running', 'paused'].includes(job.status)) {
    job.requestedStop = true;
    job.requestedPause = false;
    if (job.status === 'paused') {
      job.status = 'stopped';
      job.message = 'Assistente IA interrompido';
      job.finishedAt = new Date().toISOString();
    } else {
      job.message = 'Interrompendo ao final do item atual';
    }
  }

  return job;
}

export function queueAiMetadataAssistant(options = {}) {
  const config = getAiMetadataPublicConfig();
  if (!config.configured) {
    throw new Error('Configure e ative a IA no painel admin antes de rodar o assistente');
  }

  const job = createJob({
    limit: Math.min(Math.max(Number(options.limit || 100), 1), 1000),
    batchSize: Math.min(Math.max(Number(options.limit || options.batchSize || 100), 1), 1000),
    runAll: Boolean(options.runAll),
    generateSynopsis: options.generateSynopsis !== false,
    includeEpisodes: options.includeEpisodes !== false,
    retryRecent: options.retryRecent !== false,
    delayMs: Math.min(Math.max(Number(options.delayMs || 250), 80), 3000),
    attemptCooldownDays: Math.min(Math.max(
      Object.hasOwn(options, 'attemptCooldownDays') ? Number(options.attemptCooldownDays) : 14,
      0
    ), 365),
    minConfidence: Math.min(Math.max(Number(options.minConfidence || 0.45), 0.1), 0.95)
  });

  jobs.set(job.id, job);
  setImmediate(() => runAiMetadataJob(job).catch((error) => {
    job.status = 'error';
    job.message = error.message || 'Falha no assistente IA';
    job.finishedAt = new Date().toISOString();
    job.running = false;
  }));

  return job;
}

function getCandidateFilter(job) {
  const clauses = [
    "(tmdb_id IS NULL OR poster_url IS NULL OR poster_url = '' OR backdrop_url IS NULL OR backdrop_url = '' OR overview IS NULL OR overview = '' OR release_year IS NULL)"
  ];
  const seriesClauses = [
    "(tmdb_id IS NULL OR poster_url IS NULL OR poster_url = '' OR backdrop_url IS NULL OR backdrop_url = '' OR overview IS NULL OR overview = '' OR first_air_year IS NULL)"
  ];
  const params = [];

  if (job.options.retryRecent && job.startedAt) {
    clauses.push("(metadata_updated_at IS NULL OR metadata_updated_at < ?)");
    seriesClauses.push("(metadata_updated_at IS NULL OR metadata_updated_at < ?)");
    params.push(job.startedAt);
  } else if (job.options.attemptCooldownDays > 0) {
    clauses.push("(metadata_updated_at IS NULL OR metadata_updated_at < datetime('now', ?))");
    seriesClauses.push("(metadata_updated_at IS NULL OR metadata_updated_at < datetime('now', ?))");
    params.push(`-${job.options.attemptCooldownDays} days`);
  }

  return {
    movieSql: `WHERE ${clauses.join(' AND ')}`,
    seriesSql: `WHERE ${seriesClauses.join(' AND ')}`,
    movieParams: params,
    seriesParams: params
  };
}

function getCandidateCount(job) {
  const filter = getCandidateFilter(job);
  const movies = db.prepare(`SELECT COUNT(*) AS total FROM movies ${filter.movieSql}`).get(...filter.movieParams).total;
  const series = db.prepare(`SELECT COUNT(*) AS total FROM series ${filter.seriesSql}`).get(...filter.seriesParams).total;
  return movies + series;
}

function getCandidates(job, size = job.options.batchSize) {
  const halfLimit = Math.max(1, Math.floor(size / 2));
  const filter = getCandidateFilter(job);

  const movies = db.prepare(`
    SELECT m.id, m.title, m.release_year AS year, m.overview, m.poster_url AS posterUrl,
      m.tmdb_id AS tmdbId, COALESCE(c.name, '') AS category, 'movie' AS type
    FROM movies m
    LEFT JOIN categories c ON c.id = m.category_id
    ${filter.movieSql}
    ORDER BY m.imported_at DESC, m.id DESC
    LIMIT ?
  `).all(...filter.movieParams, halfLimit);

  const series = db.prepare(`
    SELECT s.id, s.title, s.first_air_year AS year, s.overview, s.poster_url AS posterUrl,
      s.tmdb_id AS tmdbId, COALESCE(c.name, '') AS category, 'series' AS type
    FROM series s
    LEFT JOIN categories c ON c.id = s.category_id
    ${filter.seriesSql}
    ORDER BY s.imported_at DESC, s.id DESC
    LIMIT ?
  `).all(...filter.seriesParams, size - movies.length);

  return [...movies, ...series];
}

function addError(job, message) {
  job.errors += 1;
  if (job.errorSamples.length < 8) job.errorSamples.push(message);
}

function markAttempt(candidate) {
  const table = candidate.type === 'movie' ? 'movies' : 'series';
  db.prepare(`UPDATE ${table} SET metadata_updated_at = datetime('now') WHERE id = ?`).run(candidate.id);
}

function getImportedSeasonNumbers(seriesId) {
  return db.prepare(`
    SELECT DISTINCT season_number AS seasonNumber
    FROM seasons
    WHERE series_id = ?
    ORDER BY season_number ASC
  `).all(seriesId)
    .map((season) => Number(season.seasonNumber))
    .filter((seasonNumber) => Number.isInteger(seasonNumber) && seasonNumber >= 0);
}

function countEpisodes(match = {}) {
  return (match.seasons || []).reduce((total, season) => total + (season.episodes?.length || 0), 0);
}

async function hydrateSeriesEpisodes(candidate, match, includeEpisodes) {
  if (!includeEpisodes || !match?.tmdbId) return match;

  const seasonNumbers = getImportedSeasonNumbers(candidate.id);
  if (!seasonNumbers.length) return match;

  let detailed = null;
  try {
    detailed = await getTmdbById('series', match.tmdbId, {
      includeEpisodes: true,
      seasonNumbers
    });
  } catch {
    return match;
  }

  return {
    ...match,
    ...detailed,
    overview: detailed.overview || match.overview || null,
    posterUrl: detailed.posterUrl || match.posterUrl || null,
    backdropUrl: detailed.backdropUrl || match.backdropUrl || null,
    firstAirYear: detailed.firstAirYear || match.firstAirYear || null,
    score: match.score || detailed.score
  };
}

function chatUrl(baseUrl) {
  if (baseUrl.endsWith('/chat/completions')) return baseUrl;
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

async function postChat(messages, { json = false } = {}) {
  const config = getAiMetadataConfig();
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const body = {
    model: config.model,
    messages,
    temperature: config.temperature
  };
  if (json) body.response_format = { type: 'json_object' };

  const response = await fetch(chatUrl(config.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.AI_METADATA_TIMEOUT_MS || 45000))
  });

  if (!response.ok && json && [400, 404, 422].includes(response.status)) {
    return postChat(messages, { json: false });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`IA respondeu ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || data.message?.content || '';
}

function parseJsonObject(text = '') {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) throw new Error('IA nao retornou JSON valido');
    return JSON.parse(match[0]);
  }
}

function normalizeYear(value) {
  const year = Number(value);
  const currentYear = new Date().getFullYear() + 2;
  return Number.isInteger(year) && year >= 1900 && year <= currentYear ? year : null;
}

function sanitizeAiNormalization(data, candidate) {
  const extracted = extractMetadataTitle(candidate.title);
  const title = compactSpaces(data.title || data.cleanTitle || extracted.title || candidate.title);
  const year = normalizeYear(data.year) || normalizeYear(extracted.year) || normalizeYear(candidate.year);
  const confidence = Math.min(Math.max(Number(data.confidence || 0), 0), 1);
  const searchQueries = Array.isArray(data.searchQueries)
    ? data.searchQueries.map((item) => compactSpaces(item)).filter(Boolean).slice(0, 5)
    : [];

  return {
    title,
    originalTitle: compactSpaces(data.originalTitle || ''),
    year,
    type: ['movie', 'series', 'channel', 'unknown'].includes(data.type) ? data.type : candidate.type,
    language: compactSpaces(data.language || ''),
    quality: compactSpaces(data.quality || ''),
    isAdult: Boolean(data.isAdult),
    confidence,
    searchQueries
  };
}

async function normalizeWithAi(candidate) {
  const messages = [
    {
      role: 'system',
      content: [
        'Voce organiza nomes baguncados de playlists M3U legais.',
        'Responda somente JSON valido, sem markdown.',
        'Nao invente id TMDB. Extraia apenas sinais do nome/categoria.',
        'Campos: title, originalTitle, year, type, language, quality, isAdult, confidence, searchQueries.'
      ].join(' ')
    },
    {
      role: 'user',
      content: JSON.stringify({
        title: candidate.title,
        category: candidate.category,
        expectedType: candidate.type,
        knownYear: candidate.year
      })
    }
  ];
  const content = await postChat(messages, { json: true });
  return sanitizeAiNormalization(parseJsonObject(content), candidate);
}

function titleLooksClose(a = '', b = '') {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function matchYear(match, type) {
  return type === 'series' ? match.firstAirYear : match.releaseYear;
}

function reliableMatch(match, normalized, candidate) {
  if (!match) return false;
  if ((match.score || 0) >= 70) return true;
  if (normalized.year && matchYear(match, candidate.type) && Math.abs(matchYear(match, candidate.type) - normalized.year) > 1) {
    return false;
  }
  return (match.score || 0) >= 42 && titleLooksClose(match.title, normalized.title || candidate.title);
}

function buildQueries(candidate, normalized) {
  const queries = [
    normalized.title && normalized.year ? `${normalized.title} ${normalized.year}` : '',
    normalized.title,
    ...normalized.searchQueries,
    candidate.title
  ];
  return [...new Set(queries.map((query) => compactSpaces(query)).filter(Boolean))].slice(0, 6);
}

async function findMetadataMatch(candidate, normalized) {
  for (const query of buildQueries(candidate, normalized)) {
    const match = candidate.type === 'movie'
      ? await searchMovieMetadata(query).catch(() => null)
      : await searchSeriesMetadata(query).catch(() => null);
    if (reliableMatch(match, normalized, candidate)) return match;
  }
  return null;
}

async function generateSynopsis(candidate, normalized) {
  const messages = [
    {
      role: 'system',
      content: [
        'Voce cria sinopses curtas em portugues do Brasil para uma biblioteca pessoal.',
        'Use tom neutro e evite spoilers. Responda somente JSON valido.',
        'Campos: overview.'
      ].join(' ')
    },
    {
      role: 'user',
      content: JSON.stringify({
        title: normalized.title || candidate.title,
        originalTitle: normalized.originalTitle,
        year: normalized.year || candidate.year,
        type: candidate.type === 'series' ? 'serie' : 'filme',
        category: candidate.category
      })
    }
  ];
  const content = await postChat(messages, { json: true });
  const data = parseJsonObject(content);
  const overview = compactSpaces(data.overview || '');
  if (overview.length < 20) return null;
  return `${overview} (Sinopse sugerida por IA.)`;
}

function applyGeneratedSynopsis(candidate, normalized, overview) {
  const match = {
    title: candidate.title,
    originalTitle: normalized.originalTitle || null,
    overview,
    posterUrl: null,
    backdropUrl: null,
    releaseYear: candidate.type === 'movie' ? normalized.year || candidate.year || null : null,
    firstAirYear: candidate.type === 'series' ? normalized.year || candidate.year || null : null,
    tmdbId: null,
    score: 18
  };

  if (candidate.type === 'movie') {
    updateMovieMetadata(candidate.id, match, false);
  } else {
    updateSeriesMetadata(candidate.id, match, false);
  }
}

async function processCandidate(job, candidate) {
  job.currentTitle = candidate.title;
  const normalized = await normalizeWithAi(candidate);
  if (normalized.confidence >= job.options.minConfidence) job.normalized += 1;

  if (!normalized.title || normalized.confidence < 0.25) {
    job.review += 1;
    markAttempt(candidate);
    return;
  }

  const match = await findMetadataMatch(candidate, normalized);
  if (match) {
    if (candidate.type === 'movie') {
      updateMovieMetadata(candidate.id, match, false);
    } else {
      const detailedMatch = await hydrateSeriesEpisodes(candidate, match, job.options.includeEpisodes);
      updateSeriesMetadata(candidate.id, detailedMatch, false);
      job.episodes += countEpisodes(detailedMatch);
    }
    job.matched += 1;
    return;
  }

  if (job.options.generateSynopsis && !candidate.overview) {
    const overview = await generateSynopsis(candidate, normalized).catch(() => null);
    if (overview) {
      applyGeneratedSynopsis(candidate, normalized, overview);
      job.synopsisGenerated += 1;
      return;
    }
  }

  job.skipped += 1;
  markAttempt(candidate);
}

async function runAiMetadataJob(job) {
  if (job.running) return;
  job.running = true;
  job.status = 'running';
  job.message = 'Assistente IA analisando metadados';
  job.startedAt ||= new Date().toISOString();
  job.total = getCandidateCount(job);
  console.log(`[AI Metadata] inicio: ${job.id} lote ${job.batch} ${job.processed}/${job.total}`);

  try {
    if (job.total === 0) {
      job.status = 'done';
      job.message = 'Nenhum item pendente para IA';
      job.finishedAt = new Date().toISOString();
      console.log(`[AI Metadata] vazio: ${job.id} lote ${job.batch} ${job.processed}/${job.total}`);
      return;
    }

    do {
      if (job.requestedStop) {
        job.status = 'stopped';
        job.message = 'Assistente IA interrompido';
        job.finishedAt = new Date().toISOString();
        return;
      }

      if (job.requestedPause) {
        job.status = 'paused';
        job.message = 'Assistente IA pausado';
        return;
      }

      const candidates = getCandidates(job);
      if (!candidates.length) break;
      job.batch += 1;
      job.message = `Assistente IA - lote ${job.batch}`;

      for (const candidate of candidates) {
        if (job.requestedStop) {
          job.status = 'stopped';
          job.message = 'Assistente IA interrompido';
          job.finishedAt = new Date().toISOString();
          return;
        }

        if (job.requestedPause) {
          job.status = 'paused';
          job.message = 'Assistente IA pausado';
          return;
        }

        try {
          await processCandidate(job, candidate);
        } catch (error) {
          addError(job, `${candidate.title}: ${error.message}`);
          markAttempt(candidate);
        }

        job.processed += 1;
        if (job.processed < job.total) await wait(job.options.delayMs);
      }

      if (!job.options.runAll) break;
      job.total = job.processed + getCandidateCount(job);
    } while (job.options.runAll);

    job.status = 'done';
    job.currentTitle = '';
    job.message = 'Assistente IA concluido';
    job.finishedAt = new Date().toISOString();
    console.log(`[AI Metadata] concluido: ${job.id} lote ${job.batch} ${job.processed}/${job.total}`);
  } finally {
    job.running = false;
  }
}
