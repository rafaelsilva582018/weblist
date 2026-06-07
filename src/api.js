const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const apiResponseCache = new Map();

export function getToken() {
  return localStorage.getItem('weblist_token');
}

export function setToken(token) {
  if (token) {
    localStorage.setItem('weblist_token', token);
  } else {
    localStorage.removeItem('weblist_token');
  }
  apiResponseCache.clear();
}

function cacheKeyFor(path, token) {
  return `${token || 'guest'}:${path}`;
}

function readCachedResponse(cacheKey) {
  const entry = apiResponseCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    apiResponseCache.delete(cacheKey);
    return null;
  }
  return entry;
}

export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = new Headers(options.headers || {});
  const isForm = options.body instanceof FormData;
  const method = String(options.method || 'GET').toUpperCase();
  const cacheTtlMs = Number(options.cacheTtlMs || 0);
  const cacheKey = method === 'GET' && cacheTtlMs > 0 ? cacheKeyFor(path, token) : '';

  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !isForm && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (cacheKey) {
    const cached = readCachedResponse(cacheKey);
    if (cached) {
      return cached.promise;
    }
  }

  if (method !== 'GET') {
    apiResponseCache.clear();
  }

  const request = fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: options.body && !isForm ? JSON.stringify(options.body) : options.body
  }).then(async (response) => {
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { error: raw ? raw.slice(0, 160) : '' };
    }
    if (!response.ok) {
      const error = new Error(data.error || `Falha na requisicao (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  });

  if (cacheKey) {
    apiResponseCache.set(cacheKey, {
      expiresAt: Date.now() + cacheTtlMs,
      promise: request
    });
  }

  return request.catch((error) => {
    if (cacheKey) apiResponseCache.delete(cacheKey);
    throw error;
  });
}

export function mediaLink(item) {
  if (!item) return '/';
  if (item.type === 'movie') return `/movies/${item.id}`;
  if (item.type === 'series') return `/series/${item.id}`;
  if (item.type === 'episode') return `/watch/episode/${item.id}`;
  if (item.type === 'channel') return `/watch/channel/${item.id}`;
  return '/';
}

export function watchLink(item) {
  if (!item) return '/';
  if (item.type === 'movie') return `/watch/movie/${item.id}`;
  if (item.type === 'episode') return `/watch/episode/${item.id}`;
  if (item.type === 'channel') return `/watch/channel/${item.id}`;
  return mediaLink(item);
}

export function progressPercent(progress) {
  if (!progress?.duration || progress.duration <= 0) return 0;
  return Math.min(100, Math.max(0, (progress.position / progress.duration) * 100));
}
