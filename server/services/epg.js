import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { TextDecoder } from 'node:util';
import { XMLParser } from 'fast-xml-parser';
import { db, getSetting, setSetting } from '../db.js';
import { compactSpaces, normalizeTitle } from '../utils/normalize.js';

const jobs = new Map();

function arrayify(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return compactSpaces(value);
  if (Array.isArray(value)) return textValue(value[0]);
  return compactSpaces(value['#text'] || value._ || '');
}

function attrValue(value, name) {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return attrValue(value[0], name);
  return compactSpaces(value[name] || '');
}

function normalizeChannelName(value = '') {
  return normalizeTitle(
    String(value)
      .replace(/\[[^\]]+\]/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\b(4k|uhd|fhd|hd|sd|h265|h\.265|hevc|full hd)\b/gi, ' ')
      .replace(/\s+brasil\b/gi, ' ')
      .replace(/\s+br\b/gi, ' ')
  );
}

function parseXmltvDate(value = '') {
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, sign, tzHour, tzMinute] = match;
  let timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );

  if (sign && tzHour && tzMinute) {
    const offset = (Number(tzHour) * 60 + Number(tzMinute)) * 60 * 1000;
    timestamp += sign === '+' ? -offset : offset;
  }

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function decodeXml(buffer) {
  const header = buffer.subarray(0, 300).toString('ascii');
  const encoding = header.match(/encoding=["']([^"']+)["']/i)?.[1]?.toLowerCase() || 'utf-8';
  if (encoding.includes('8859') || encoding.includes('latin')) {
    return new TextDecoder('latin1').decode(buffer);
  }
  return new TextDecoder('utf-8').decode(buffer);
}

async function loadXml({ url = '', content = '' }) {
  if (content.trim()) {
    return content.trim();
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Informe uma URL XMLTV valida');
  }

  const response = await fetch(url, {
    headers: {
      Accept: 'application/xml,text/xml,application/gzip,*/*',
      'User-Agent': 'Weblist/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`EPG respondeu ${response.status}`);
  }

  let buffer = Buffer.from(await response.arrayBuffer());
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    buffer = gunzipSync(buffer);
  }

  return decodeXml(buffer);
}

function buildChannelMatcher(epgChannels) {
  const channels = db.prepare(`
    SELECT id, title, normalized_title AS normalizedTitle, tvg_id AS tvgId, tvg_name AS tvgName
    FROM channels
  `).all();

  const byTvgId = new Map();
  const byName = new Map();
  const pushMatch = (map, key, channelId) => {
    if (!key) return;
    const ids = map.get(key) || [];
    if (!ids.includes(channelId)) ids.push(channelId);
    map.set(key, ids);
  };

  for (const channel of channels) {
    if (channel.tvgId) pushMatch(byTvgId, String(channel.tvgId).toLowerCase(), channel.id);

    for (const candidate of [channel.tvgName, channel.title, channel.normalizedTitle]) {
      const key = normalizeChannelName(candidate);
      pushMatch(byName, key, channel.id);
    }
  }

  const epgNames = new Map();
  for (const channel of epgChannels) {
    const id = attrValue(channel, 'id');
    if (!id) continue;
    const displayNames = arrayify(channel['display-name']).map(textValue).filter(Boolean);
    epgNames.set(id, displayNames);
  }

  return (epgChannel) => {
    const raw = compactSpaces(epgChannel);
    if (!raw) return [];

    const exact = byTvgId.get(raw.toLowerCase());
    if (exact) return exact;

    const candidates = [raw, ...(epgNames.get(raw) || [])];
    for (const candidate of candidates) {
      const key = normalizeChannelName(candidate);
      if (key && byName.has(key)) return byName.get(key);
    }

    return [];
  };
}

function createJob(input) {
  return {
    id: randomUUID(),
    status: 'queued',
    message: 'Aguardando EPG',
    url: input.url || '',
    totalPrograms: 0,
    processed: 0,
    imported: 0,
    matchedChannels: 0,
    errors: 0,
    errorSamples: [],
    startedAt: null,
    finishedAt: null
  };
}

function addError(job, message) {
  job.errors += 1;
  if (job.errorSamples.length < 8) job.errorSamples.push(message);
}

export function queueEpgImport(input = {}) {
  const job = createJob(input);
  jobs.set(job.id, job);

  setImmediate(async () => {
    try {
      await importEpg(job, input);
    } catch (error) {
      job.status = 'error';
      job.message = error.message || 'Falha ao importar EPG';
      job.finishedAt = new Date().toISOString();
    }
  });

  return job;
}

export function getEpgJob(id) {
  return jobs.get(id) || null;
}

export async function importEpg(job, input) {
  job.status = 'running';
  job.message = 'Baixando EPG';
  job.startedAt = new Date().toISOString();

  const xml = await loadXml(input);
  if (input.url) setSetting('epg_url', input.url);

  job.message = 'Lendo XMLTV';
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
    trimValues: true
  });
  const parsed = parser.parse(xml);
  const tv = parsed?.tv;
  if (!tv) throw new Error('XMLTV invalido: tag <tv> nao encontrada');

  const epgChannels = arrayify(tv.channel);
  const programmes = arrayify(tv.programme);
  const matchChannel = buildChannelMatcher(epgChannels);
  const matchedChannelIds = new Set();

  job.totalPrograms = programmes.length;
  job.message = 'Importando programacao';

  const insertProgram = db.prepare(`
    INSERT INTO epg_programs (
      channel_id, epg_channel, title, subtitle, description, category, icon_url, start_at, stop_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN IMMEDIATE');
  let transactionOpen = true;
  let batch = 0;

  try {
    db.exec('DELETE FROM epg_programs');

    for (const programme of programmes) {
      job.processed += 1;
      const epgChannel = attrValue(programme, 'channel');
      const channelIds = matchChannel(epgChannel);
      if (!channelIds.length) {
        batch += 1;
        continue;
      }

      const startAt = parseXmltvDate(attrValue(programme, 'start'));
      const stopAt = parseXmltvDate(attrValue(programme, 'stop'));
      const title = textValue(programme.title);
      if (!startAt || !stopAt || !title || stopAt <= startAt) {
        addError(job, `Programa ignorado: ${title || epgChannel || 'sem titulo'}`);
        batch += 1;
        continue;
      }

      for (const channelId of channelIds) {
        insertProgram.run(
          channelId,
          epgChannel,
          title,
          textValue(programme['sub-title']) || null,
          textValue(programme.desc) || null,
          textValue(programme.category) || null,
          attrValue(programme.icon, 'src') || null,
          startAt,
          stopAt
        );
        job.imported += 1;
        matchedChannelIds.add(channelId);
      }
      job.matchedChannels = matchedChannelIds.size;
      batch += 1;

      if (batch >= 1000) {
        db.exec('COMMIT');
        transactionOpen = false;
        await new Promise((resolve) => setImmediate(resolve));
        db.exec('BEGIN IMMEDIATE');
        transactionOpen = true;
        batch = 0;
      }
    }

    if (transactionOpen) {
      db.exec('COMMIT');
      transactionOpen = false;
    }

    setSetting('epg_last_imported_at', new Date().toISOString());
    job.status = 'done';
    job.message = 'EPG importada';
    job.finishedAt = new Date().toISOString();
  } catch (error) {
    if (transactionOpen) db.exec('ROLLBACK');
    throw error;
  }
}

function mapProgram(row) {
  if (!row) return null;
  return {
    id: row.id,
    channelId: row.channel_id,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    category: row.category,
    iconUrl: row.icon_url,
    startAt: row.start_at,
    stopAt: row.stop_at
  };
}

export function getEpgStatus() {
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS programs,
      COUNT(DISTINCT channel_id) AS channels,
      MIN(start_at) AS startsAt,
      MAX(stop_at) AS stopsAt,
      MAX(created_at) AS importedAt
    FROM epg_programs
  `).get();

  return {
    url: getSetting('epg_url', ''),
    lastImportedAt: getSetting('epg_last_imported_at', stats.importedAt || ''),
    programs: stats.programs || 0,
    channels: stats.channels || 0,
    startsAt: stats.startsAt || null,
    stopsAt: stats.stopsAt || null
  };
}

export function getCurrentProgram(channelId, now = new Date()) {
  const iso = now.toISOString();
  return mapProgram(db.prepare(`
    SELECT *
    FROM epg_programs
    WHERE channel_id = ? AND start_at <= ? AND stop_at > ?
    ORDER BY start_at DESC
    LIMIT 1
  `).get(channelId, iso, iso));
}

export function getNextProgram(channelId, now = new Date()) {
  const iso = now.toISOString();
  return mapProgram(db.prepare(`
    SELECT *
    FROM epg_programs
    WHERE channel_id = ? AND start_at > ?
    ORDER BY start_at ASC
    LIMIT 1
  `).get(channelId, iso));
}

export function getChannelGuide(channelId, hours = 12) {
  const now = new Date();
  const until = new Date(now.getTime() + Math.min(Math.max(Number(hours) || 12, 1), 48) * 60 * 60 * 1000);
  return db.prepare(`
    SELECT *
    FROM epg_programs
    WHERE channel_id = ? AND stop_at > ? AND start_at < ?
    ORDER BY start_at ASC
    LIMIT 120
  `).all(channelId, now.toISOString(), until.toISOString()).map(mapProgram);
}

export function attachCurrentPrograms(items = []) {
  if (!items.length) return items;
  const now = new Date().toISOString();
  const statement = db.prepare(`
    SELECT title, subtitle, start_at, stop_at
    FROM epg_programs
    WHERE channel_id = ? AND start_at <= ? AND stop_at > ?
    ORDER BY start_at DESC
    LIMIT 1
  `);

  return items.map((item) => {
    if (item.type !== 'channel') return item;
    const current = statement.get(item.id, now, now);
    return current
      ? {
          ...item,
          currentProgram: {
            title: current.title,
            subtitle: current.subtitle,
            startAt: current.start_at,
            stopAt: current.stop_at
          }
        }
      : item;
  });
}
