import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiFetch } from '../api.js';
import EmptyState from '../components/EmptyState.jsx';
import Pagination from '../components/Pagination.jsx';
import PosterCard from '../components/PosterCard.jsx';

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') || '';
  const type = searchParams.get('type') || 'all';
  const metadata = searchParams.get('metadata') || 'all';
  const year = searchParams.get('year') || '';
  const hideAdult = searchParams.get('hideAdult') !== 'false';
  const page = Number(searchParams.get('page') || 1);
  const [items, setItems] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ q, type, metadata, year, hideAdult: hideAdult ? 'true' : 'false', page: String(page), limit: '60' });
    return params.toString();
  }, [hideAdult, metadata, page, q, type, year]);

  useEffect(() => {
    if (!q.trim()) {
      setItems([]);
      setPagination(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    apiFetch(`/search?${queryString}`)
      .then((data) => {
        setItems(data.items || []);
        setPagination(data.pagination || null);
      })
      .finally(() => setLoading(false));
  }, [q, queryString]);

  function changeType(event) {
    const next = new URLSearchParams(searchParams);
    next.set('type', event.target.value);
    next.set('page', '1');
    setSearchParams(next);
  }

  function setParam(key, value) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.set('page', '1');
    setSearchParams(next);
  }

  function changePage(nextPage) {
    const next = new URLSearchParams(searchParams);
    next.set('page', String(nextPage));
    setSearchParams(next);
  }

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-4xl font-black text-white">Busca</h1>
          <p className="mt-2 text-sm text-slate-400">{q ? `${q} - titulos e atores` : 'Busque por titulo ou ator'}</p>
          {pagination && <p className="mt-1 text-xs text-slate-500">Pagina {pagination.page} de {pagination.totalPages} - {pagination.total} no total</p>}
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <select value={type} onChange={changeType} className="rounded border border-white/10 bg-panel px-3 py-2 text-sm text-white">
            <option value="all">Todos</option>
            <option value="movie">Filmes</option>
            <option value="series">Series</option>
            <option value="channel">Canais</option>
          </select>
          <select value={metadata} onChange={(event) => setParam('metadata', event.target.value)} className="rounded border border-white/10 bg-panel px-3 py-2 text-sm text-white">
            <option value="all">Metadados</option>
            <option value="missingAny">Sem capa/sinopse</option>
            <option value="withPoster">Com capa</option>
            <option value="withOverview">Com sinopse</option>
          </select>
          <input
            value={year}
            onChange={(event) => setParam('year', event.target.value.replace(/\D/g, '').slice(0, 4))}
            className="rounded border border-white/10 bg-panel px-3 py-2 text-sm text-white outline-none placeholder:text-slate-500"
            placeholder="Ano"
          />
          <button
            type="button"
            onClick={() => setParam('hideAdult', hideAdult ? 'false' : 'true')}
            className="rounded border border-white/10 bg-panel px-3 py-2 text-sm font-bold text-slate-200 hover:bg-white/8"
          >
            {hideAdult ? 'Adultos ocultos' : 'Mostrar todos'}
          </button>
        </div>
      </div>

      {loading && <div className="py-20 text-slate-300">Carregando...</div>}
      {!loading && !items.length && <EmptyState title="Nada encontrado" />}
      {!loading && items.length > 0 && (
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
