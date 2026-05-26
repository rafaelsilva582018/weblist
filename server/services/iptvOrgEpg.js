import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { dataDir, projectRoot, setSetting } from '../db.js';
import { importEpg } from './epg.js';

const repoUrl = 'https://github.com/iptv-org/epg.git';
const repoDir = path.join(projectRoot, 'tools', 'iptv-org-epg');
const combinedChannelsPath = path.join(dataDir, 'iptv-org-br.channels.xml');
const outputPath = path.join(dataDir, 'iptv-org-guide.xml');
const jobs = new Map();

const brazilChannelFiles = [
  'sites/app.tvufop.com.br/app.tvufop.com.br.channels.xml',
  'sites/claro.com.br/claro.com.br.channels.xml',
  'sites/clarotvmais.com.br/clarotvmais.com.br.channels.xml',
  'sites/meuguia.tv/meuguia.tv.channels.xml',
  'sites/mi.tv/mi.tv_br.channels.xml',
  'sites/vivoplay.com.br/vivoplay.com.br.channels.xml',
  'sites/x1co.com.br/x1co.com.br.channels.xml'
];

function createJob() {
  return {
    id: randomUUID(),
    status: 'queued',
    message: 'Aguardando iptv-org',
    source: 'iptv-org Brasil',
    totalPrograms: 0,
    processed: 0,
    imported: 0,
    matchedChannels: 0,
    errors: 0,
    errorSamples: [],
    commandLog: [],
    startedAt: null,
    finishedAt: null
  };
}

function addLog(job, message) {
  const clean = String(message || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!clean) return;
  job.commandLog.push(clean);
  if (job.commandLog.length > 20) job.commandLog.shift();
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function runCommand(job, command, args, cwd, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: true,
      windowsHide: true
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Tempo limite ao executar iptv-org'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => addLog(job, chunk));
    child.stderr.on('data', (chunk) => addLog(job, chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} finalizou com codigo ${code}`));
      }
    });
  });
}

async function ensureIptvOrgRepo(job) {
  await fs.mkdir(path.dirname(repoDir), { recursive: true });

  if (!(await exists(path.join(repoDir, '.git')))) {
    job.message = 'Baixando iptv-org/epg';
    await runCommand(job, 'git', ['clone', '--depth', '1', '-b', 'master', repoUrl, repoDir], projectRoot);
  }

  if (!(await exists(path.join(repoDir, 'node_modules')))) {
    job.message = 'Instalando iptv-org/epg';
    await runCommand(job, 'npm', ['install'], repoDir);
  }
}

function arrayify(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

async function buildBrazilChannelsFile(job) {
  job.message = 'Montando canais brasileiros';
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
    trimValues: true
  });
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
    format: true
  });
  const channels = [];

  for (const relativePath of brazilChannelFiles) {
    const filePath = path.join(repoDir, relativePath);
    if (!(await exists(filePath))) continue;

    const parsed = parser.parse(await fs.readFile(filePath, 'utf8'));
    for (const channel of arrayify(parsed?.channels?.channel)) {
      if (!channel) continue;
      if (!channel.lang || channel.lang === 'pt') channels.push(channel);
    }
  }

  if (!channels.length) {
    throw new Error('Nenhum canal brasileiro encontrado no iptv-org');
  }

  await fs.writeFile(
    combinedChannelsPath,
    builder.build({ channels: { channel: channels } }),
    'utf8'
  );
  return channels.length;
}

export function queueIptvOrgEpgImport() {
  const job = createJob();
  jobs.set(job.id, job);

  setImmediate(async () => {
    try {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      await ensureIptvOrgRepo(job);
      const channelCount = await buildBrazilChannelsFile(job);

      job.message = `Gerando XMLTV iptv-org (${channelCount} canais)`;
      await runCommand(
        job,
        'npm',
        [
          'run',
          'grab',
          '--',
          `--channels=${combinedChannelsPath}`,
          `--output=${outputPath}`,
          '--days=2',
          '--maxConnections=2',
          '--timeout=20000'
        ],
        repoDir
      );

      const xml = await fs.readFile(outputPath, 'utf8');
      await importEpg(job, { content: xml });
      setSetting('epg_url', 'iptv-org Brasil');
      job.message = 'EPG iptv-org importada';
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
    } catch (error) {
      job.status = 'error';
      job.message = error.message || 'Falha ao importar iptv-org';
      job.finishedAt = new Date().toISOString();
    }
  });

  return job;
}

export function getIptvOrgEpgJob(id) {
  return jobs.get(id) || null;
}
