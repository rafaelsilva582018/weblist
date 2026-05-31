import { Star } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiFetch } from '../api.js';
import EmptyState from '../components/EmptyState.jsx';
import Pagination from '../components/Pagination.jsx';
import PosterCard from '../components/PosterCard.jsx';

const filters = [
  { value: 'all', label: 'Todos' },
  { value: 'movie', label: 'Filmes' },
  { value: 'series', label: 'Series' },
  { value: 'channel', label: 'Canais' }
];

export default function FavoritesPage() {
  const [urlParams, setUrlParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const type = urlParams.get('type') || 'all';
  const page = Math.max(1, Number(urlParams.get('page') || 1) || 1);

  const query = useMemo(() => {
    const params = new URLSearchParams({ type, page: String(page), limit: '60' });
    return params.toString();
  }, [page, type]);

  useEffect(() => {
    setLoading(true);
    apiFetch(`/favorites?${query}`)
      .then((data) => {
        setItems(data.items || []);
        setPagination(data.pagination || null);
        setError('');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [query]);

  function handleFavoriteChange(item, next) {
    if (next) return;
    setItems((current) => current.filter((candidate) => !(candidate.type === item.type && candidate.id === item.id)));
    setPagination((current) => current ? { ...current, total: Math.max(0, current.total - 1) } : current);
  }

  function changeType(nextType) {
    const next = new URLSearchParams(urlParams);
    if (nextType === 'all') next.delete('type');
    else next.set('type', nextType);
    next.delete('page');
    setUrlParams(next, { replace: true });
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
          <div className="mb-3 inline-flex items-center gap-2 rounded bg-amber-400 px-3 py-1 text-xs font-black uppercase text-ink">
            <Star size={14} fill="currentColor" />
            Favoritos
          </div>
          <h1 className="text-4xl font-black text-white">Favoritos</h1>
          <p className="mt-2 text-sm text-slate-400">Tudo que voce marcou para assistir depois.</p>
          {pagination && <p className="mt-1 text-xs text-slate-500">Pagina {pagination.page} de {pagination.totalPages} - {pagination.total} no total</p>}
        </div>

        <div className="grid grid-cols-2 overflow-hidden rounded border border-white/10 bg-panel p-1 sm:grid-cols-4">
          {filters.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => changeType(filter.value)}
              className={`rounded px-3 py-2 text-sm font-bold ${type === filter.value ? 'bg-white text-ink' : 'text-slate-300 hover:bg-white/8'}`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="py-20 text-slate-300">Carregando...</div>}
      {error && <EmptyState title={error} />}
      {!loading && !error && !items.length && (
        <EmptyState title="Nenhum favorito ainda" action={{ to: '/', label: 'Explorar biblioteca' }} />
      )}
      {!loading && !error && items.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {items.map((item) => (
              <PosterCard key={`${item.type}-${item.id}`} item={item} onFavoriteChange={handleFavoriteChange} />
            ))}
          </div>
          <Pagination pagination={pagination} onPage={changePage} />
        </>
      )}
    </div>
  );
}
