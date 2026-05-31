import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import {
  getMetadataPublicConfig,
  searchMovieMetadata,
  searchSeriesMetadata,
  updateMovieMetadata,
  updateSeriesMetadata
} from './tmdb.js';

const jobs = new Map();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progressLogEvery() {
  const value = Number(process.env.TMDB_PROGRESS_LOG_EVERY || 100);
  return Number.isFinite(value) ? Math.min(Math.max(value, 10), 5000) : 100;
}

function logJobProgress(job, reason = 'progresso') {
  console.log(
    `[TMDB] ${reason}: ${job.id} lote ${job.batch} ${job.processed}/${job.total} ` +
    `encontradas=${job.matched} sem_match=${job.skipped} erros=${job.errors}`
  );
}

function createJob(options) {
  return {
    id: randomUUID(),
    status: 'queued',
    message: 'Aguardando TMDB',
    processed: 0,
    matched: 0,
    skipped: 0,
    errors: 0,
    errorSamples: [],
    total: 0,
    batch: 0,
    requestedPause: false,
    requestedStop: false,
    running: false,
    options,
    startedAt: null,
    finishedAt: null
  };
}

export function getEnrichJob(id) {
  return jobs.get(id) || null;
}

export function getActiveEnrichJob() {
  return [...jobs.values()].find((job) => ['queued', 'running', 'paused'].includes(job.status) && !job.requestedStop) || null;
}

export function updateEnrichJob(id, action) {
  const job = getEnrichJob(id);
  if (!job) return null;

  if (action === 'pause' && job.status === 'running') {
    job.requestedPause = true;
    job.message = 'Pausando ao final do item atual';
  }

  if (action === 'resume' && job.status === 'paused') {
    job.requestedPause = false;
    job.status = 'running';
    job.message = 'Retomando TMDB';
    setImmediate(() => runTmdbJob(job).catch((error) => {
      job.status = 'error';
      job.message = error.message || 'Falha ao consultar TMDB';
      job.finishedAt = new Date().toISOString();
      job.running = false;
    }));
  }

  if (action === 'stop' && ['queued', 'running', 'paused'].includes(job.status)) {
    job.requestedStop = true;
    job.requestedPause = false;
    if (job.status === 'paused') {
      job.status = 'stopped';
      job.message = 'Atualizacao interrompida';
      job.finishedAt = new Date().toISOString();
    } else {
      job.message = 'Interrompendo ao final do item atual';
    }
  }

  return job;
}

export function queueTmdbEnrichment(options = {}) {
  const config = getMetadataPublicConfig();
  if (!config.configured) {
    throw new Error('Configure uma chave TMDB ou OMDb antes de atualizar capas');
  }

  const force = Boolean(options.force);
  const hasAttemptOption = Object.hasOwn(options, 'markAttempts');
  const retryDays = Object.hasOwn(options, 'attemptCooldownDays') ? Number(options.attemptCooldownDays) : force ? 0 : 14;

  const job = createJob({
    limit: Math.min(Math.max(Number(options.limit || 1000), 1), 2000),
    batchSize: Math.min(Math.max(Number(options.limit || options.batchSize || 1000), 1), 2000),
    runAll: Boolean(options.runAll),
    force,
    delayMs: Math.min(Math.max(Number(options.delayMs || 120), 40), 1000),
    markAttempts: hasAttemptOption ? Boolean(options.markAttempts) : !force,
    attemptCooldownDays: Math.min(Math.max(Number.isFinite(retryDays) ? retryDays : 0, 0), 365)
  });
  jobs.set(job.id, job);

  setImmediate(() => runTmdbJob(job).catch((error) => {
    job.status = 'error';
    job.message = error.message || 'Falha ao consultar TMDB';
    job.finishedAt = new Date().toISOString();
  }));

  return job;
}

function getCandidateFilter(job) {
  if (job.options.force) return { sql: '', params: [] };

  const clauses = [
    "(tmdb_id IS NULL OR poster_url IS NULL OR poster_url = '' OR backdrop_url IS NULL OR backdrop_url = '' OR overview IS NULL OR overview = '')"
  ];
  const params = [];

  if (job.options.attemptCooldownDays > 0) {
    clauses.push("(metadata_updated_at IS NULL OR metadata_updated_at < datetime('now', ?))");
    params.push(`-${job.options.attemptCooldownDays} days`);
  }

  return {
    sql: `WHERE ${clauses.join(' AND ')}`,
    params
  };
}

function getCandidateCount(job) {
  if (job.options.force) {
    const movies = db.prepare('SELECT COUNT(*) AS total FROM movies').get().total;
    const series = db.prepare('SELECT COUNT(*) AS total FROM series').get().total;
    return movies + series;
  }

  const filter = getCandidateFilter(job);
  const movies = db.prepare(`SELECT COUNT(*) AS total FROM movies ${filter.sql}`).get(...filter.params).total;
  const series = db.prepare(`SELECT COUNT(*) AS total FROM series ${filter.sql}`).get(...filter.params).total;
  return movies + series;
}

function getCandidates(job, size = job.options.batchSize) {
  if (job.options.force) {
    return db.prepare(`
      SELECT id, title, type
      FROM (
        SELECT id, title, imported_at AS importedAt, 'movie' AS type
        FROM movies

        UNION ALL

        SELECT id, title, imported_at AS importedAt, 'series' AS type
        FROM series
      )
      ORDER BY importedAt DESC, type ASC, id DESC
      LIMIT ? OFFSET ?
    `).all(size, job.processed);
  }

  const halfLimit = Math.max(1, Math.floor(size / 2));
  const filter = getCandidateFilter(job);

  const movies = db.prepare(`
    SELECT id, title
    FROM movies
    ${filter.sql}
    ORDER BY imported_at DESC, id DESC
    LIMIT ?
  `).all(...filter.params, halfLimit).map((item) => ({ ...item, type: 'movie' }));

  const series = db.prepare(`
    SELECT id, title
    FROM series
    ${filter.sql}
    ORDER BY imported_at DESC, id DESC
    LIMIT ?
  `).all(...filter.params, size - movies.length).map((item) => ({ ...item, type: 'series' }));

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

async function runTmdbJob(job) {
  if (job.running) return;
  job.running = true;
  job.status = 'running';
  job.message = 'Consultando TMDB';
  job.startedAt ||= new Date().toISOString();
  job.total = getCandidateCount(job);
  logJobProgress(job, 'inicio');

  try {
    do {
      if (job.requestedStop) {
        job.status = 'stopped';
        job.message = 'Atualizacao interrompida';
        job.finishedAt = new Date().toISOString();
        logJobProgress(job, 'parado');
        return;
      }

      if (job.requestedPause) {
        job.status = 'paused';
        job.message = 'Atualizacao pausada';
        logJobProgress(job, 'pausado');
        return;
      }

      const candidates = getCandidates(job);
      if (!candidates.length) break;
      job.batch += 1;
      job.message = `Consultando TMDB - lote ${job.batch}`;
      logJobProgress(job, 'lote');

      for (const candidate of candidates) {
        if (job.requestedStop) {
          job.status = 'stopped';
          job.message = 'Atualizacao interrompida';
          job.finishedAt = new Date().toISOString();
          logJobProgress(job, 'parado');
          return;
        }

        if (job.requestedPause) {
          job.status = 'paused';
          job.message = 'Atualizacao pausada';
          logJobProgress(job, 'pausado');
          return;
        }

        try {
          const match = candidate.type === 'movie'
            ? await searchMovieMetadata(candidate.title)
            : await searchSeriesMetadata(candidate.title);

          if (!match) {
            job.skipped += 1;
            if (job.options.markAttempts) markAttempt(candidate);
          } else if (candidate.type === 'movie') {
            updateMovieMetadata(candidate.id, match, job.options.force);
            job.matched += 1;
          } else {
            updateSeriesMetadata(candidate.id, match, job.options.force);
            job.matched += 1;
          }
        } catch (error) {
          addError(job, `${candidate.title}: ${error.message}`);
        }

        job.processed += 1;
        if (job.processed % progressLogEvery() === 0) {
          logJobProgress(job);
        }
        if (job.processed < job.total) {
          await wait(job.options.delayMs);
        }
      }

      if (!job.options.runAll) break;
      if (!job.options.force) job.total = job.processed + getCandidateCount(job);
    } while (job.options.runAll);

    job.status = 'done';
    job.message = 'Capas atualizadas';
    job.finishedAt = new Date().toISOString();
    logJobProgress(job, 'concluido');
  } finally {
    job.running = false;
  }
}
