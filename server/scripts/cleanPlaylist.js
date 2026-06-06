import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { classifyItem, cleanChannelTitle, parseEpisodeInfo, parseExtInf } from '../parser/m3uParser.js';
import { compactSpaces, normalizeTitle } from '../utils/normalize.js';

const inputPath = process.argv[2];
const outputPath = process.argv[3] || defaultOutputPath(inputPath);

if (!inputPath) {
  console.error('Uso: node server/scripts/cleanPlaylist.js <entrada.m3u> [saida.m3u]');
  process.exit(1);
}

const normalizedAdultGroups = new Set(['casa do patrao']);
const alwaysChannelGroupMap = new Map([
  ['eleven sports', 'CANAIS | ELEVEN SPORTS'],
  ['infantis', 'CANAIS | INFANTIS'],
  ['max', 'CANAIS | MAX'],
  ['musicas', 'CANAIS | MUSICAS'],
  ['noticias internacionais', 'CANAIS | NOTICIAS INTERNACIONAIS'],
  ['pay per view', 'CANAIS | PAY-PER-VIEW'],
  ['nba pay per view', 'CANAIS | NBA PAY-PER-VIEW'],
  ['record tv', 'CANAIS | RECORD TV'],
  ['sbt', 'CANAIS | SBT'],
  ['sportv', 'CANAIS | SPORTV'],
  ['variedades', 'CANAIS | VARIEDADES']
]);
const forcedGroupMap = new Map([
  ['jogos do dia', 'ESPORTES AO VIVO'],
  ['brasileirao', 'ESPORTES AO VIVO'],
  ['abertos', 'CANAIS | ABERTOS'],
  ['noticias', 'CANAIS | NOTICIAS'],
  ['esportes', 'CANAIS | ESPORTES']
]);
const channelGroupMap = new Map([
  ['filmes e series', 'CANAIS | FILMES E SERIES'],
  ['legendados', 'CANAIS | LEGENDADOS'],
  ['h265 hevc', 'CANAIS | HEVC'],
  ['uhd 4k', 'CANAIS | 4K'],
  ['documentarios', 'CANAIS | DOCUMENTARIOS']
]);
const providerLiveGroups = new Set([
  'disney',
  'netflix',
  'amazon prime video',
  'hbo max',
  'globoplay',
  'paramount',
  'appletv',
  'crunchyroll',
  'star'
]);

const stats = {
  total: 0,
  forcedChannels: 0,
  explicitAdultChannels: 0,
  syntheticTvgIds: 0,
  groupRetags: 0
};

function defaultOutputPath(sourcePath = '') {
  if (!sourcePath) return '';
  const parsed = path.parse(sourcePath);
  return path.join(parsed.dir, `${parsed.name}-weblist${parsed.ext || '.m3u'}`);
}

function escapeAttr(value = '') {
  return String(value).replace(/"/g, '&quot;');
}

function escapeTitle(value = '') {
  return compactSpaces(String(value || '')).replace(/\r?\n/g, ' ');
}

function buildExtInfLine(meta, overrides = {}) {
  const attrs = { ...(meta.attrs || {}) };
  const nextTitle = escapeTitle(overrides.title ?? meta.rawTitle ?? meta.name ?? '');

  if (overrides.tvgId !== undefined) attrs['tvg-id'] = overrides.tvgId;
  if (overrides.tvgName !== undefined) attrs['tvg-name'] = overrides.tvgName;
  if (overrides.logo !== undefined) attrs['tvg-logo'] = overrides.logo;
  if (overrides.group !== undefined) attrs['group-title'] = overrides.group;

  const ordered = [];
  const seen = new Set();
  for (const key of ['tvg-id', 'tvg-name', 'tvg-logo', 'group-title']) {
    if (Object.prototype.hasOwnProperty.call(attrs, key)) {
      ordered.push([key, attrs[key]]);
      seen.add(key);
    }
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (seen.has(key)) continue;
    ordered.push([key, value]);
  }

  const attrText = ordered
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}="${escapeAttr(value)}"`)
    .join(' ');

  return attrText ? `#EXTINF:-1 ${attrText},${nextTitle}` : `#EXTINF:-1,${nextTitle}`;
}

function normalizeKey(value = '') {
  return normalizeTitle(value).replace(/\s+/g, ' ').trim();
}

function titleHasQualityToken(value = '') {
  return /\b(?:fhd|full hd|uhd|4k|hd|sd)\b/i.test(value);
}

function titleHasYear(value = '') {
  return /\b(?:19|20)\d{2}\b/.test(value);
}

function titleLooksEvent(value = '') {
  return /\b\d{1,2}:\d{2}\b|\b(?:x|vs)\b|court\b|practice\b|treinos?\b|rodada\b|moto ?gp\b|padel\b|tenis\b|tennis\b/i.test(value);
}

function titleLooksLinearChannel(value = '') {
  if (parseEpisodeInfo(value)) return false;
  if (titleHasYear(value)) return false;
  return (
    titleHasQualityToken(value)
    || /\b(?:tv|canal|news|sport|premiere|espn|globo|record|sbt|band|disney|hbo|telecine|tnt|warner|sony|animal planet|multicam)\b/i.test(value)
  );
}

function isHiddenAdultChannel(group = '', title = '') {
  return normalizedAdultGroups.has(normalizeKey(group));
}

function syntheticTvgId(meta, prefix = 'CHAN') {
  const base = cleanChannelTitle(meta.tvgId || meta.tvgName || meta.name || meta.rawTitle || '') || 'Canal';
  const normalized = normalizeTitle(base).replace(/\s+/g, '_').toUpperCase().slice(0, 64);
  return `${prefix}_${normalized || 'ITEM'}`;
}

function normalizeProviderGroup(group = '') {
  const key = normalizeKey(group);
  if (key === 'disney') return 'DISNEY+';
  if (key === 'paramount') return 'PARAMOUNT+';
  if (key === 'star') return 'STAR+';
  if (key === 'appletv') return 'APPLETV+';
  return compactSpaces(group || 'CANAIS');
}

function chooseOverrides(meta, url) {
  const title = compactSpaces(meta.name || meta.rawTitle || 'Sem titulo');
  const group = compactSpaces(meta.group || 'Sem categoria');
  const groupKey = normalizeKey(group);
  const currentType = classifyItem(meta, url).type;
  const overrides = {
    title,
    group,
    tvgId: compactSpaces(meta.tvgId || ''),
    tvgName: compactSpaces(meta.tvgName || title)
  };

  if (isHiddenAdultChannel(group, title)) {
    overrides.group = 'CANAIS | ADULTOS';
    if (!overrides.tvgId) {
      overrides.tvgId = syntheticTvgId(meta, 'ADULT');
      stats.syntheticTvgIds += 1;
    }
    overrides.tvgName = title;
    stats.forcedChannels += 1;
    stats.explicitAdultChannels += 1;
    return overrides;
  }

  if (['jogos do dia', 'brasileirao'].includes(groupKey)) {
    overrides.group = forcedGroupMap.get(groupKey);
    if (!overrides.tvgId) {
      overrides.tvgId = syntheticTvgId(meta, 'EVENTO');
      stats.syntheticTvgIds += 1;
    }
    overrides.tvgName = title;
    stats.forcedChannels += 1;
    return overrides;
  }

  if (alwaysChannelGroupMap.has(groupKey)) {
    overrides.group = alwaysChannelGroupMap.get(groupKey);
    if (!overrides.tvgId) {
      const isEventGroup = /\bpay per view\b/.test(groupKey);
      overrides.tvgId = syntheticTvgId(meta, isEventGroup && titleLooksEvent(title) ? 'EVENTO' : 'CANAL');
      stats.syntheticTvgIds += 1;
    }
    overrides.tvgName = title;
    if (overrides.group !== group) {
      stats.groupRetags += 1;
    }
    stats.forcedChannels += 1;
    return overrides;
  }

  if (forcedGroupMap.has(groupKey) && titleLooksLinearChannel(title)) {
    overrides.group = forcedGroupMap.get(groupKey);
    if (!overrides.tvgId) {
      overrides.tvgId = syntheticTvgId(meta, titleLooksEvent(title) ? 'EVENTO' : 'CANAL');
      stats.syntheticTvgIds += 1;
    }
    overrides.tvgName = title;
    stats.forcedChannels += 1;
    return overrides;
  }

  if (currentType === 'channel') {
    if (channelGroupMap.has(groupKey)) {
      overrides.group = channelGroupMap.get(groupKey);
    } else if (providerLiveGroups.has(groupKey) && (titleLooksEvent(title) || /\b[a-z]+\s+\d+\b/i.test(normalizeKey(title)))) {
      overrides.group = `CANAIS | ${normalizeProviderGroup(group)}`;
    }

    if (overrides.group !== group) {
      stats.groupRetags += 1;
    }
  }

  return overrides;
}

async function cleanPlaylist() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Arquivo nao encontrado: ${inputPath}`);
  }

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const input = fs.createReadStream(inputPath, { encoding: 'utf8' });
  const output = fs.createWriteStream(outputPath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });

  let pendingMeta = null;
  let pendingRawLine = '';

  for await (const rawLine of reader) {
    const line = rawLine.trim();

    if (!pendingMeta) {
      if (line.startsWith('#EXTINF')) {
        pendingMeta = parseExtInf(rawLine);
        pendingRawLine = rawLine;
      } else {
        output.write(`${rawLine}\n`);
      }
      continue;
    }

    if (!line || line.startsWith('#')) {
      output.write(`${pendingRawLine}\n`);
      pendingMeta = null;
      pendingRawLine = '';
      output.write(`${rawLine}\n`);
      continue;
    }

    stats.total += 1;
    const next = chooseOverrides(pendingMeta, rawLine);
    output.write(`${buildExtInfLine(pendingMeta, next)}\n`);
    output.write(`${rawLine}\n`);

    pendingMeta = null;
    pendingRawLine = '';
  }

  if (pendingMeta) {
    output.write(`${pendingRawLine}\n`);
  }

  await new Promise((resolve, reject) => {
    output.end((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

cleanPlaylist()
  .then(() => {
    console.log(JSON.stringify({
      input: inputPath,
      output: outputPath,
      stats
    }, null, 2));
  })
  .catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
