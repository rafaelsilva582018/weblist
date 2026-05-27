import { getActiveEnrichJob, queueTmdbEnrichment } from './enricher.js';
import { getTmdbPublicConfig } from './tmdb.js';

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'sim'].includes(String(value).toLowerCase());
}

function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export function getAutoTmdbConfig() {
  return {
    enabled: boolEnv('AUTO_TMDB_ENABLED', false),
    runOnStart: boolEnv('AUTO_TMDB_RUN_ON_START', true),
    startDelaySeconds: numberEnv('AUTO_TMDB_START_DELAY_SECONDS', 45, 5, 3600),
    intervalMinutes: numberEnv('AUTO_TMDB_INTERVAL_MINUTES', 360, 5, 10080),
    batchSize: numberEnv('AUTO_TMDB_BATCH_SIZE', 1000, 1, 2000),
    runAll: boolEnv('AUTO_TMDB_RUN_ALL', true),
    force: boolEnv('AUTO_TMDB_FORCE', false),
    delayMs: numberEnv('AUTO_TMDB_DELAY_MS', 160, 40, 2000),
    retryDays: numberEnv('AUTO_TMDB_RETRY_DAYS', 14, 0, 365)
  };
}

export function startAutoTmdbEnrichment() {
  const config = getAutoTmdbConfig();
  if (!config.enabled) {
    console.log('Auto TMDB desativado');
    return null;
  }

  let lastJobId = null;
  let lastRunAt = null;
  let lastMessage = 'Aguardando primeira execucao';

  const run = (reason) => {
    const active = getActiveEnrichJob();
    if (active) {
      lastMessage = `Pulando: fila TMDB ja esta ${active.status}`;
      console.log(`[Auto TMDB] ${lastMessage}`);
      return;
    }

    const tmdb = getTmdbPublicConfig();
    if (!tmdb.configured) {
      lastMessage = 'Pulando: configure uma chave TMDB';
      console.log(`[Auto TMDB] ${lastMessage}`);
      return;
    }

    try {
      const job = queueTmdbEnrichment({
        limit: config.batchSize,
        batchSize: config.batchSize,
        runAll: config.runAll,
        force: config.force,
        delayMs: config.delayMs,
        markAttempts: true,
        attemptCooldownDays: config.retryDays
      });
      lastJobId = job.id;
      lastRunAt = new Date().toISOString();
      lastMessage = `Fila iniciada (${reason})`;
      console.log(`[Auto TMDB] ${lastMessage}: ${job.id}`);
    } catch (error) {
      lastMessage = error.message || 'Falha ao iniciar fila TMDB';
      console.error(`[Auto TMDB] ${lastMessage}`);
    }
  };

  if (config.runOnStart) {
    setTimeout(() => run('inicio'), config.startDelaySeconds * 1000);
  }

  const interval = setInterval(() => run('intervalo'), config.intervalMinutes * 60 * 1000);
  console.log(`[Auto TMDB] Ativo: lote ${config.batchSize}, intervalo ${config.intervalMinutes} min, retry ${config.retryDays} dias`);

  return {
    config,
    interval,
    status: () => ({ lastJobId, lastRunAt, lastMessage })
  };
}
