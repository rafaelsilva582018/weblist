import path from 'node:path';
import { clearLibrary, getStats, initDatabase, projectRoot } from '../db.js';
import { getImportJob, queueImport } from '../services/importer.js';

initDatabase();
clearLibrary();

const playlistPath = path.join(projectRoot, 'sample', 'playlist.m3u');
const job = queueImport(playlistPath, { cleanup: false });

const timer = setInterval(() => {
  const current = getImportJob(job.id);
  if (!current || !['done', 'error'].includes(current.status)) return;

  clearInterval(timer);
  console.log(current);
  console.log(getStats());
  process.exit(current.status === 'done' ? 0 : 1);
}, 300);
