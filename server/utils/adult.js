import { compactSpaces } from './normalize.js';

const categoryAdultTokens = [
  'adulto',
  'adulta',
  'adultos',
  'adultas',
  'xxx',
  '18+',
  '+18',
  'porn',
  'er_tic',
  'sexo',
  'hentai',
  'priv_',
  'sexy',
  'bella da semana'
];

const titleAdultTokens = [
  '[xxx]',
  'xxx',
  '18+',
  '+18',
  'porn',
  'er_tic',
  'sexo',
  'hentai',
  'priv_',
  'sexy',
  'bella da semana'
];

const adultCategoryPattern = /(?:\[xxx\]|\b(?:18\+|\+18|adulto|adulta|adultos|adultas|porn(?:o)?|er.?t(?:ic|ico|ica|icos|icas)?|sexo|hentai|priv.?|sexy)\b|bella da semana)/i;
const adultTitlePattern = /(?:\[xxx\]|\b(?:18\+|\+18|porn(?:o)?|er.?t(?:ic|ico|ica|icos|icas)?|sexo|hentai|priv.?|sexy)\b|bella da semana)/i;

function normalizeAdultText(value = '') {
  return compactSpaces(
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
  );
}

function escapeSqlLikeToken(value) {
  return String(value).replace(/'/g, "''");
}

function buildNotLikeClauses(column, tokens) {
  return tokens.map((token) => `${column} NOT LIKE '%${escapeSqlLikeToken(token)}%' COLLATE NOCASE`);
}

export function isAdultText(...values) {
  const [title = '', category = ''] = values;
  const normalizedTitle = normalizeAdultText(title);
  const normalizedCategory = normalizeAdultText(category);
  return adultTitlePattern.test(normalizedTitle) || adultCategoryPattern.test(normalizedCategory);
}

export function buildAdultExclusionClauses({ titleColumn = '', categoryColumn = '' } = {}) {
  const clauses = [];
  if (categoryColumn) {
    clauses.push(...buildNotLikeClauses(`COALESCE(${categoryColumn}, '')`, categoryAdultTokens));
  }
  if (titleColumn) {
    clauses.push(...buildNotLikeClauses(titleColumn, titleAdultTokens));
  }
  return clauses;
}
