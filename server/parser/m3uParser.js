import { compactSpaces, normalizeTitle } from '../utils/normalize.js';

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
  return compactSpaces(
    value
      .replace(/\[[^\]]+\]/g, ' ')
      .replace(/\([^)]*(1080p|720p|2160p|4k|uhd|fhd|hd|sd|dual audio|dublado|legendado)[^)]*\)/gi, ' ')
      .replace(/\b(2160p|1080p|720p|480p|4k|uhd|fhd|h265|hd|sd|dual audio|dublado|legendado|dub|leg)\b/gi, ' ')
  );
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

  if (/\b(canal|canais|ao vivo|radio)\b/.test(normalizedGroup)) return true;
  if (/\b24h\b|\b24 horas\b/.test(normalizedGroup) && !isSeriesGroup(group)) return true;

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

export function extractMetadataTitle(value = '') {
  const cleaned = cleanCatalogTitle(value);
  const yearMatch = cleaned.match(/\((19\d{2}|20\d{2})\)\s*$/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const title = compactSpaces(cleaned.replace(/\((19\d{2}|20\d{2})\)\s*$/g, ''));
  return { title: title || cleaned, year };
}

function isSeriesGroup(group) {
  return /\b(series|serie|seriados|novelas|novela|anime|animes|dorama|doramas|programas)\b/.test(normalizeTitle(group));
}

export function classifyItem(meta, url) {
  if (isChannelGroup(meta.group, meta.name)) {
    return { type: 'channel' };
  }

  const episodeInfo = parseEpisodeInfo(meta.name || meta.rawTitle || '');
  if (episodeInfo) {
    return { type: 'episode', ...episodeInfo };
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
