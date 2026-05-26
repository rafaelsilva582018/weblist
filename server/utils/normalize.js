export function normalizeTitle(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function compactSpaces(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function padNumber(value, size = 2) {
  return String(Number(value) || 0).padStart(size, '0');
}
