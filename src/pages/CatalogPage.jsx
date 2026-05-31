import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiFetch } from '../api.js';
import EmptyState from '../components/EmptyState.jsx';
import Pagination from '../components/Pagination.jsx';
import PosterCard from '../components/PosterCard.jsx';

const labels = {
  movie: { title: 'Filmes', endpoint: '/movies' },
  series: { title: 'Series', endpoint: '/series' },
  channel: { title: 'Canais', endpoint: '/channels' }
};

export default function CatalogPage({ type }) {
  const config = labels[type];
  const [urlParams, setUrlParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const query = urlParams.get('q') || '';
  const category = urlParams.get('category') || 'all';
  const sort = urlParams.get('sort') || 'imported';
  const metadata = urlParams.get('metadata') || 'all';
  const year = urlParams.get('year') || '';
  const hideAdult = urlParams.get('hideAdult') !== 'false';
  const page = Math.max(1, Number(urlParams.get('page') || 1) || 1);

  const requestParams = useMemo(() => {
    const params = new URLSearchParams({ sort, page: String(page), limit: type === 'channel' ? '96' : '60' });
    if (query.trim()) params.set('q', query.trim());
    if (category !== 'all') params.set('category', category);
    params.set('hideAdult', hideAdult ? 'true' : 'false');
    if (type !== 'channel') {
      if (metadata !== 'all') params.set('metadata', metadata);
      if (year.trim()) params.set('year', year.trim());
    }
    return params.toString();
  }, [category, hideAdult, metadata, page, query, sort, type, year]);

  useEffect(() => {
    setLoading(true);
    apiFetch(`${config.endpoint}?${requestParams}`)
      .then((data) => {
        setItems(data.items || []);
        setPagination(data.pagination || null);
        setError('');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [config.endpoint, requestParams]);

  useEffect(() => {
    apiFetch(`/categories?type=${type}`).then((data) => setCategories(data.categories || [])).catch(() => setCategories([]));
  }, [type]);

  const visibleCategories = hideAdult
    ? categories.filter((item) => !/adult|xxx/i.test(item.name))
    : categories;

  function updateParam(key, value, options = {}) {
    const next = new URLSearchParams(urlParams);
    const resetPage = options.resetPage !== false;
    const defaults = { category: 'all', sort: 'imported', metadata: 'all', hideAdult: 'true', page: '1' };
    const cleanValue = String(value || '').trim();

    if (!cleanValue || cleanValue === defaults[key]) next.delete(key);
    else next.set(key, cleanValue);
    if (resetPage) next.delete('page');
    setUrlParams(next, { replace: options.replace ?? resetPage });
  }

  function changePage(nextPage) {
    const next = new URLSearchParams(urlParams);
    if (nextPage <= 1) next.delete('page');
    else next.set('page', String(nextPage));
    setUrlParams(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-4xl font-black text-white">{config.title}</h1>
          <p className="mt-2 text-sm text-slate-400">{items.length} itens</p>
          {pagination && <p className="mt-1 text-xs text-slate-500">Pagina {pagination.page} de {pagination.totalPages} - {pagination.total} no total</p>}
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(220px,1fr)_170px_160px]">
          <label className="flex items-center gap-2 rounded border border-white/10 bg-white/6 px-3 py-2">
            <Search size={17} className="text-muted" />
            <input
              value={query}
              onChange={(event) => updateParam('q', event.target.value)}
              className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-500"
              placeholder="Buscar"
            />
          </label>
          <select value={category} onChange={(event) => updateParam('category', event.target.value)} className="rounded border border-white/10 bg-panel px-3 py-2 text-sm text-white">
            <option value="all">Categorias</option>
            {visibleCategories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <select value={sort} onChange={(event) => updateParam('sort', event.target.value)} className="rounded border border-white/10 bg-panel px-3 py-2 text-sm text-white">
            <option value="imported">Recentes</option>
            <option value="name">Nome</option>
            <option value="category">Categoria</option>
          </select>
        </div>
      </div>

      <div className={`mb-6 grid gap-3 rounded border border-white/10 bg-white/5 p-3 ${type === 'channel' ? 'sm:grid-cols-[1fr]' : 'sm:grid-cols-[180px_180px_1fr]'}`}>
        {type !== 'channel' && (
          <>
            <select value={metadata} onChange={(event) => updateParam('metadata', event.target.value)} className="rounded border border-white/10 bg-panel px-3 py-2 text-sm text-white">
              <option value="all">Metadados</option>
              <option value="missingAny">Sem capa/sinopse</option>
              <option value="missingPoster">Sem capa</option>
              <option value="withPoster">Com capa</option>
              <option value="missingOverview">Sem sinopse</option>
              <option value="withOverview">Com sinopse</option>
            </select>
            <input
              value={year}
              onChange={(event) => updateParam('year', event.target.value.replace(/\D/g, '').slice(0, 4))}
              className="rounded border border-white/10 bg-panel px-3 py-2 text-sm text-white outline-none placeholder:text-slate-500"
              placeholder="Ano"
            />
          </>
        )}
          <div className="grid grid-cols-2 overflow-hidden rounded border border-white/10 bg-panel p-1">
            <button
              type="button"
              onClick={() => updateParam('hideAdult', 'true')}
              className={`rounded px-3 py-2 text-sm font-bold ${hideAdult ? 'bg-white text-ink' : 'text-slate-300 hover:bg-white/8'}`}
            >
              Ocultar adultos
            </button>
            <button
              type="button"
              onClick={() => updateParam('hideAdult', 'false')}
              className={`rounded px-3 py-2 text-sm font-bold ${!hideAdult ? 'bg-white text-ink' : 'text-slate-300 hover:bg-white/8'}`}
            >
              Mostrar todos
            </button>
          </div>
      </div>

      {loading && <div className="py-20 text-slate-300">Carregando...</div>}
      {error && <EmptyState title={error} />}
      {!loading && !error && !items.length && <EmptyState title="Nada encontrado" />}
      {!loading && !error && items.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {items.map((item) => (
              <PosterCard key={`${item.type}-${item.id}`} item={item} />
            ))}
          </div>
          <Pagination pagination={pagination} onPage={changePage} />
        </>
      )}
    </div>
  );
}
