import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import {
  getTmdbPublicConfig,
  searchTmdbMovie,
  searchTmdbSeries,
  updateMovieMetadata,
  updateSeriesMetadata
} from './tmdb.js';

const jobs = new Map();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const config = getTmdbPublicConfig();
  if (!config.configured) {
    throw new Error('Configure uma chave TMDB antes de atualizar capas');
  }

  const job = createJob({
    limit: Math.min(Math.max(Number(options.limit || 1000), 1), 2000),
    batchSize: Math.min(Math.max(Number(options.limit || options.batchSize || 1000), 1), 2000),
    runAll: Boolean(options.runAll),
    force: Boolean(options.force),
    delayMs: Math.min(Math.max(Number(options.delayMs || 120), 40), 1000)
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
  return job.options.force
    ? ''
    : "WHERE tmdb_id IS NULL OR poster_url IS NULL OR poster_url = '' OR backdrop_url IS NULL OR backdrop_url = '' OR overview IS NULL OR overview = ''";
}

function getCandidateCount(job) {
  if (job.options.force) {
    const movies = db.prepare('SELECT COUNT(*) AS total FROM movies').get().total;
    const series = db.prepare('SELECT COUNT(*) AS total FROM series').get().total;
    return movies + series;
  }

  const filter = getCandidateFilter(job);
  const movies = db.prepare(`SELECT COUNT(*) AS total FROM movies ${filter}`).get().total;
  const series = db.prepare(`SELECT COUNT(*) AS total FROM series ${filter}`).get().total;
  return movies + series;
}

function getCandidates(job, size = job.options.batchSize) {
  const halfLimit = Math.max(1, Math.floor(size / 2));
  const filter = job.options.force
    ? ''
    : "WHERE tmdb_id IS NULL OR poster_url IS NULL OR poster_url = '' OR backdrop_url IS NULL OR backdrop_url = '' OR overview IS NULL OR overview = ''";

  const movies = db.prepare(`
    SELECT id, title
    FROM movies
    ${filter}
    ORDER BY imported_at DESC, id DESC
    LIMIT ?
  `).all(halfLimit).map((item) => ({ ...item, type: 'movie' }));

  const series = db.prepare(`
    SELECT id, title
    FROM series
    ${filter}
    ORDER BY imported_at DESC, id DESC
    LIMIT ?
  `).all(size - movies.length).map((item) => ({ ...item, type: 'series' }));

  return [...movies, ...series];
}

function addError(job, message) {
  job.errors += 1;
  if (job.errorSamples.length < 8) job.errorSamples.push(message);
}

async function runTmdbJob(job) {
  if (job.running) return;
  job.running = true;
  job.status = 'running';
  job.message = 'Consultando TMDB';
  job.startedAt ||= new Date().toISOString();
  job.total = getCandidateCount(job);

  try {
    do {
      if (job.requestedStop) {
        job.status = 'stopped';
        job.message = 'Atualizacao interrompida';
        job.finishedAt = new Date().toISOString();
        return;
      }

      if (job.requestedPause) {
        job.status = 'paused';
        job.message = 'Atualizacao pausada';
        return;
      }

      const candidates = getCandidates(job);
      if (!candidates.length) break;
      job.batch += 1;
      job.message = `Consultando TMDB - lote ${job.batch}`;

      for (const candidate of candidates) {
        if (job.requestedStop) {
          job.status = 'stopped';
          job.message = 'Atualizacao interrompida';
          job.finishedAt = new Date().toISOString();
          return;
        }

        if (job.requestedPause) {
          job.status = 'paused';
          job.message = 'Atualizacao pausada';
          return;
        }

        try {
          const match = candidate.type === 'movie'
            ? await searchTmdbMovie(candidate.title)
            : await searchTmdbSeries(candidate.title);

          if (!match) {
            job.skipped += 1;
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
        if (job.processed < job.total) {
          await wait(job.options.delayMs);
        }
      }

      if (!job.options.runAll || job.options.force) break;
      job.total = job.processed + getCandidateCount(job);
    } while (job.options.runAll);

    job.status = 'done';
    job.message = 'Capas atualizadas';
    job.finishedAt = new Date().toISOString();
  } finally {
    job.running = false;
  }
}
