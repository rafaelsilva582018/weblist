const API_BASE = import.meta.env.VITE_API_BASE || '/api';

export function getToken() {
  return localStorage.getItem('weblist_token');
}

export function setToken(token) {
  if (token) {
    localStorage.setItem('weblist_token', token);
  } else {
    localStorage.removeItem('weblist_token');
  }
}

export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = new Headers(options.headers || {});
  const isForm = options.body instanceof FormData;

  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !isForm && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: options.body && !isForm ? JSON.stringify(options.body) : options.body
  });

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
