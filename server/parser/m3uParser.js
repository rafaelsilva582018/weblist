import { compactSpaces, normalizeTitle } from '../utils/normalize.js';

const variantTokenPattern = [
  '2160p',
  '1080p',
  '720p',
  '480p',
  '4k',
  'uhd',
  'full hd',
  'fhd',
  'hd',
  'sd',
  'h265',
  'h\\.265',
  'hevc',
  'x265',
  'x\\.265',
  'dual audio',
  'multi audio',
  'dublado',
  'dublada',
  'dublados',
  'dubladas',
  'dub',
  'legendado',
  'legendada',
  'legendados',
  'legendadas',
  'leg',
  'subtitulado',
  'subtitulada',
  'sub'
].join('|');

const qualityPatterns = [
  { label: '4K', regex: /\b(?:2160p|4k|uhd)\b/i },
  { label: 'Full HD', regex: /\b(?:1080p|full hd|fhd)\b/i },
  { label: 'HD', regex: /\b(?:720p|hd)\b/i },
  { label: 'SD', regex: /\b(?:480p|sd)\b/i }
];

const languagePatterns = [
  { label: 'Dual Audio', regex: /\b(?:dual audio|multi audio)\b/i },
  { label: 'Legendado', regex: /\b(?:legendado|legendada|legendados|legendadas|leg|subtitulado|subtitulada|sub)\b/i },
  { label: 'Dublado', regex: /\b(?:dublado|dublada|dublados|dubladas|dub)\b/i }
];

const codecPatterns = [
  { label: 'HEVC', regex: /\b(?:hevc|h265|h\.265|x265|x\.265)\b/i }
];

const explicitChannelGroups = new Set([
  'cine sky',
  'eleven sports',
  'infantis',
  'max',
  'musicas',
  'noticias internacionais',
  'pay per view',
  'record tv',
  'sbt',
  'sportv',
  'variedades'
]);

function splitOutsideQuotes(value, separator = ',') {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== '\\') {
      quote = quote === char ? null : quote || char;
      continue;
    }
    if (char === separator && !quote) {
      return [value.slice(0, index), value.slice(index + 1)];
    }
  }
  return [value, ''];
}

function parseAttributes(value) {
  const attrs = {};
  const regex = /([a-zA-Z0-9_-]+)=("([^"]*)"|'([^']*)'|([^\s,]+))/g;
  let match;

  while ((match = regex.exec(value)) !== null) {
    attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? '';
  }

  return attrs;
}

function is24HourGroup(group = '') {
  return /\b24h\b|\b24 horas\b/.test(normalizeTitle(group));
}

export function isLikelyLiveStreamUrl(value = '') {
  const url = String(value || '').trim().toLowerCase();
  return /\/live\//.test(url) || /\.m3u8(?:$|[?#])/.test(url) || /\.ts(?:$|[?#])/.test(url);
}

export function parseM3uHeader(line = '') {
  if (!String(line).toUpperCase().startsWith('#EXTM3U')) return {};
  return parseAttributes(line.replace(/^#EXTM3U/i, ''));
}

function cleanMediaName(value = '') {
  return compactSpaces(
    String(value)
      .replace(/\.(m3u8?|mp4|mkv|avi|mov)$/i, '')
      .replace(/\s+-\s+$/, '')
  );
}

function extractSuperscriptEdition(value = '') {
  const match = String(value).match(/([¹²³⁴⁵⁶⁷⁸⁹]+)\s*$/);
  if (!match) return null;

  const digits = match[1]
    .replace(/¹/g, '1')
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .replace(/⁴/g, '4')
    .replace(/⁵/g, '5')
    .replace(/⁶/g, '6')
    .replace(/⁷/g, '7')
    .replace(/⁸/g, '8')
    .replace(/⁹/g, '9');

  const edition = Number.parseInt(digits, 10);
  return Number.isInteger(edition) && edition > 1 ? edition : null;
}

export function extractStreamVariantInfo(value = '') {
  const text = compactSpaces(value);
  const quality = qualityPatterns.find((entry) => entry.regex.test(text))?.label || '';
  const language = languagePatterns.find((entry) => entry.regex.test(text))?.label || '';
  const codec = codecPatterns.find((entry) => entry.regex.test(text))?.label || '';
  const edition = extractSuperscriptEdition(text);

  return { quality, language, codec, edition };
}

export function formatSourceLabel(variant = {}, fallback = 'Opcao') {
  const parts = [variant.quality, variant.language, variant.codec].filter(Boolean);
  let label = parts.join(' - ') || fallback;
  if (variant.edition) {
    label = `${label} (${variant.edition})`;
  }
  return label;
}

export function stripVariantTokens(value = '') {
  return compactSpaces(
    String(value)
      .replace(/\[[^\]]*(2160p|1080p|720p|480p|4k|uhd|full hd|fhd|hd|sd|h265|h\.265|hevc|x265|x\.265|dual audio|multi audio|dublado|dublada|dub|legendado|legendada|leg|subtitulado|subtitulada|sub)[^\]]*\]/gi, ' ')
      .replace(/\([^)]*(2160p|1080p|720p|480p|4k|uhd|full hd|fhd|hd|sd|h265|h\.265|hevc|x265|x\.265|dual audio|multi audio|dublado|dublada|dub|legendado|legendada|leg|subtitulado|subtitulada|sub)[^)]*\)/gi, ' ')
      .replace(new RegExp(`(?:^|\\s|[\\/|_-])(?:${variantTokenPattern})(?=$|\\s|[\\/|_\\-()\\[\\]¹²³⁴⁵⁶⁷⁸⁹])`, 'gi'), ' ')
      .replace(/[¹²³⁴⁵⁶⁷⁸⁹]+/g, ' ')
  );
}

export function parseExtInf(line) {
  const payload = line.replace(/^#EXTINF:/i, '');
  const [attributesPart, titlePart] = splitOutsideQuotes(payload, ',');
  const attrs = parseAttributes(attributesPart);
  const name = cleanMediaName(attrs['tvg-name'] || attrs.name || titlePart || attrs.title || '');

  return {
    name,
    tvgId: attrs['tvg-id'] || attrs.tvgid || attrs.channel || '',
    tvgName: attrs['tvg-name'] || attrs.name || '',
    logo: attrs['tvg-logo'] || attrs.logo || '',
    group: compactSpaces(attrs['group-title'] || attrs.group || 'Sem categoria'),
    rawTitle: cleanMediaName(titlePart),
    attrs
  };
}

function stripQualityTags(value) {
  return stripVariantTokens(value);
}

function cleanSeriesTitle(value) {
  return compactSpaces(
    value
      .replace(/[._]+/g, ' ')
      .replace(/\s*[-:|]\s*$/g, '')
  );
}

function cleanEpisodeTitle(value = '') {
  return compactSpaces(
    String(value)
      .replace(/^[\s-_:|]+/, '')
      .replace(/\s+\[[^\]]+\]$/g, '')
  );
}

const metadataNoisePattern = /\b(?:hdr|dv|dolby vision|cam|telecine|telesync|hdts|hdtc)\b/gi;
const metadataBracketPattern = /[\[(](?:l|leg|legendado|legendada|d|dub|dublado|dublada|cam|hdr|dv|dolby vision|sdr|uhd|4k|fhd|full hd|hd)[\])]/gi;

function trimDecorativeQuotes(value = '') {
  return compactSpaces(
    String(value)
      .replace(/^[“”"'`]+/, '')
      .replace(/[“”"'`]+$/g, '')
  );
}

function stripMetadataDecorators(value = '') {
  return compactSpaces(
    String(value)
      .replace(/^\s*24h?\s*-\s*/i, '')
      .replace(metadataBracketPattern, ' ')
      .replace(metadataNoisePattern, ' ')
      .replace(/\[\s*\]|\(\s*\)/g, ' ')
      .replace(/\s{2,}/g, ' ')
  );
}

function extractTrailingYear(value = '') {
  let text = compactSpaces(String(value));
  let detectedYear = null;
  const patterns = [
    /\((19\d{2}|20\d{2})\)\s*$/i,
    /(?:[-–—/:|]\s*|\s+)(19\d{2}|20\d{2})\s*$/i
  ];

  for (let index = 0; index < 2; index += 1) {
    let matched = false;

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;

      const year = Number(match[1]);
      if (Number.isInteger(year)) {
        detectedYear = year;
      }
      text = compactSpaces(text.slice(0, match.index));
      matched = true;
      break;
    }

    if (!matched) break;
  }

  return { title: text, year: detectedYear };
}

export function parseEpisodeInfo(name = '') {
  const title = stripQualityTags(cleanMediaName(name));
  const patterns = [
    /^(?<series>.+?)\s*[-_. ]+[Ss](?<season>\d{1,2})\s*(?:[Ee]|Ep\.?)\s*(?<episode>\d{1,4})(?:\s*[-_:]\s*(?<title>.+))?$/i,
    /^(?<series>.+?)\s*[-_. ]+(?<season>\d{1,2})x(?<episode>\d{1,4})(?:\s*[-_:]\s*(?<title>.+))?$/i,
    new RegExp('^(?<series>.+?)\\s*[-_. ]+(?:Temporada|Temp\\.?|T)\\s*(?<season>\\d{1,2})\\s*[-_. ]*(?:Epis[o\\u00f3]dio|Ep\\.?|E)\\s*(?<episode>\\d{1,4})(?:\\s*[-_:]\\s*(?<title>.+))?$', 'i')
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (!match?.groups) continue;

    const seriesTitle = cleanSeriesTitle(match.groups.series);
    const season = Number.parseInt(match.groups.season, 10);
    const episode = Number.parseInt(match.groups.episode, 10);
    const episodeTitle = cleanEpisodeTitle(match.groups.title || '');

    if (seriesTitle && Number.isInteger(season) && Number.isInteger(episode)) {
      return { seriesTitle, season, episode, episodeTitle };
    }
  }

  return null;
}

function isChannelGroup(group, name) {
  const normalizedGroup = normalizeTitle(group);
  const normalizedName = normalizeTitle(name);

  if (explicitChannelGroups.has(normalizedGroup) || /\bpay per view\b/.test(normalizedGroup)) return true;
  if (/\b(canal|canais|ao vivo|radio)\b/.test(normalizedGroup)) return true;
  if (is24HourGroup(group) && !isSeriesGroup(group)) return true;

  return !normalizedGroup && /\b(live|ao vivo|radio)\b/.test(normalizedName);
}

export function cleanCatalogTitle(value = '') {
  return compactSpaces(
    stripQualityTags(cleanMediaName(value))
      .replace(/^\[xxx\]\s*/i, '')
      .replace(/\s+\((?<year>19\d{2}|20\d{2})\)\s*$/i, ' ($<year>)')
      .replace(/\s+-\s*$/g, '')
  );
}

export function cleanChannelTitle(value = '') {
  return compactSpaces(
    stripVariantTokens(cleanMediaName(value))
      .replace(/^\[xxx\]\s*/i, '')
      .replace(/\s+-\s*$/g, '')
      .replace(/\s+\/\s*$/g, '')
  );
}

export function extractMetadataTitle(value = '') {
  const cleaned = stripMetadataDecorators(cleanCatalogTitle(value));
  const extracted = extractTrailingYear(cleaned);
  const title = trimDecorativeQuotes(
    compactSpaces(
      extracted.title
        .replace(/\s*[-–—/:|]+\s*$/g, '')
        .replace(/\s{2,}/g, ' ')
    )
  );

  return {
    title: title || trimDecorativeQuotes(cleaned),
    year: extracted.year
  };
}

function isSeriesGroup(group) {
  return /\b(series|serie|seriados|novelas|novela|anime|animes|dorama|doramas|programas)\b/.test(normalizeTitle(group));
}

function isLikelyTvgChannel(meta = {}) {
  const tvgId = compactSpaces(meta.tvgId || meta.attrs?.['tvg-id'] || '');
  if (!tvgId) return false;
  if (isSeriesGroup(meta.group)) return false;

  const title = cleanChannelTitle(meta.name || meta.rawTitle || meta.tvgName || '');
  if (!title) return false;

  return !parseEpisodeInfo(title);
}

export function classifyItem(meta, url) {
  if (is24HourGroup(meta.group) && isLikelyLiveStreamUrl(url)) {
    return { type: 'channel' };
  }

  if (isChannelGroup(meta.group, meta.name)) {
    return { type: 'channel' };
  }

  const episodeInfo = parseEpisodeInfo(meta.name || meta.rawTitle || '');
  if (episodeInfo) {
    return { type: 'episode', ...episodeInfo };
  }

  if (isLikelyTvgChannel(meta)) {
    return { type: 'channel' };
  }

  if (isSeriesGroup(meta.group)) {
    const title = cleanCatalogTitle(meta.name || meta.rawTitle || '');
    return { type: 'episode', seriesTitle: title, season: 1, episode: 1, episodeTitle: title };
  }

  return { type: 'movie' };
}

export function isProbablyPlayableUrl(value = '') {
  const url = String(value).trim();
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url);
}
