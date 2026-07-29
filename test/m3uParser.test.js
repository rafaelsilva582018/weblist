import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyItem,
  extractStreamVariantInfo,
  parseEpisodeInfo,
  parseExtInf,
  stripVariantTokens
} from '../server/parser/m3uParser.js';

test('parseExtInf reads common IPTV attributes', () => {
  const meta = parseExtInf('#EXTINF:-1 tvg-id="canal.br" tvg-name="Canal HD" tvg-logo="https://img/logo.png" group-title="Canais",Canal HD');

  assert.equal(meta.name, 'Canal HD');
  assert.equal(meta.tvgId, 'canal.br');
  assert.equal(meta.logo, 'https://img/logo.png');
  assert.equal(meta.group, 'Canais');
});

test('classifyItem detects series episodes', () => {
  const meta = parseExtInf('#EXTINF:-1 group-title="Series",Minha Serie S02E05 - Final');
  const item = classifyItem(meta, 'https://example.com/series/minha-serie-s02e05.mp4');

  assert.equal(item.type, 'episode');
  assert.equal(item.seriesTitle, 'Minha Serie');
  assert.equal(item.season, 2);
  assert.equal(item.episode, 5);
  assert.equal(item.episodeTitle, 'Final');
});

test('classifyItem keeps live channel groups as channels', () => {
  const meta = parseExtInf('#EXTINF:-1 tvg-id="news.br" group-title="Noticias",News Brasil');
  const item = classifyItem(meta, 'https://example.com/live/news.ts');

  assert.equal(item.type, 'channel');
});

test('classifyItem defaults VOD entries to movies', () => {
  const meta = parseExtInf('#EXTINF:-1 group-title="Filmes",Grande Filme 2025');
  const item = classifyItem(meta, 'https://example.com/movie/grande-filme.mp4');

  assert.equal(item.type, 'movie');
});

test('extractStreamVariantInfo and stripVariantTokens identify source variants', () => {
  assert.deepEqual(extractStreamVariantInfo('Titulo 1080p Dual Audio H.265'), {
    quality: 'Full HD',
    language: 'Dual Audio',
    codec: 'HEVC',
    edition: null
  });
  assert.equal(stripVariantTokens('Titulo 1080p Dual Audio'), 'Titulo');
});

test('parseEpisodeInfo supports 1x02 format', () => {
  assert.deepEqual(parseEpisodeInfo('Outra Serie 1x02 - Piloto'), {
    seriesTitle: 'Outra Serie',
    season: 1,
    episode: 2,
    episodeTitle: 'Piloto'
  });
});
