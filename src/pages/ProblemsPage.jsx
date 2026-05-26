import { AlertTriangle, ExternalLink, RefreshCcw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch, mediaLink } from '../api.js';
import ManualTmdbModal from '../components/ManualTmdbModal.jsx';

function SmallStat({ label, value }) {
  return (
    <div className="rounded border border-white/10 bg-white/6 p-4">
      <p className="text-sm text-slate-400">{label}</p>
      <p className="mt-2 text-3xl font-black text-white">{value ?? 0}</p>
    </div>
  );
}

function ProblemItem({ item, onFix }) {
  const typeLabel = { movie: 'F', series: 'S', channel: 'C' }[item.type] || '?';

  return (
    <div className="flex min-h-[92px] items-center gap-3 rounded border border-white/10 bg-white/6 p-3">
      <div className="grid h-16 w-12 shrink-0 place-items-center overflow-hidden rounded bg-white/8 text-sm font-black text-white">
        {item.posterUrl ? <img src={item.posterUrl} alt={item.title} className="h-full w-full object-cover" /> : typeLabel}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold text-white">{item.title}</p>
        <p className="truncate text-sm text-slate-400">{item.category || item.type}</p>
      </div>
      <button onClick={() => onFix(item)} className="grid size-10 place-items-center rounded bg-white text-ink hover:bg-slate-200" title="Corrigir TMDB">
        <Search size={17} />
      </button>
      <Link to={mediaLink(item)} className="grid size-10 place-items-center rounded border border-white/10 text-slate-200 hover:bg-white/8" title="Abrir">
        <ExternalLink size={17} />
      </Link>
    </div>
  );
}

export default function ProblemsPage() {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');

  function load() {
    apiFetch('/problems?limit=60')
      .then((next) => {
        setData(next);
        setError('');
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function searchLibrary(event) {
    event?.preventDefault();
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    setError('');
    try {
      const params = new URLSearchParams({ q: query.trim(), type, limit: '48' });
      const result = await apiFetch(`/admin/media/search?${params.toString()}`);
      setSearchResults(result.items || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  }

  function refreshAfterApply() {
    load();
    if (query.trim()) searchLibrary();
  }

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="flex items-center gap-3 text-4xl font-black text-white">
            <AlertTriangle size={34} />
            Problemas
          </h1>
          <p className="mt-2 text-sm text-slate-400">Itens sem metadados, duplicados provaveis e series suspeitas.</p>
        </div>
        <button onClick={load} className="inline-flex items-center gap-2 rounded bg-white px-4 py-3 text-sm font-black text-ink hover:bg-slate-200">
          <RefreshCcw size={17} />
          Atualizar
        </button>
      </div>

      {error && <p className="mb-6 rounded border border-red-500/30 bg-red-950/30 p-3 text-sm text-red-200">{error}</p>}

      <form onSubmit={searchLibrary} className="mb-8 rounded border border-white/10 bg-white/6 p-4">
        <div className="flex flex-col gap-3 lg:flex-row">
          <label className="flex flex-1 items-center gap-2 rounded border border-white/10 bg-black/24 px-3 py-2">
            <Search size={17} className="text-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full bg-transparent text-white outline-none placeholder:text-slate-500"
              placeholder="Buscar filme, serie ou canal"
            />
          </label>
          <select value={type} onChange={(event) => setType(event.target.value)} className="rounded border border-white/10 bg-black/24 px-3 py-2 text-white outline-none">
            <option value="all">Todos</option>
            <option value="movie">Filmes</option>
            <option value="series">Series</option>
            <option value="channel">Canais</option>
          </select>
          <button disabled={searching} className="inline-flex items-center justify-center gap-2 rounded bg-white px-5 py-3 text-sm font-black text-ink hover:bg-slate-200 disabled:opacity-60">
            <Search size={17} />
            Buscar
          </button>
        </div>

        {searchResults.length > 0 && (
          <div className="mt-4 grid gap-2 lg:grid-cols-2">
            {searchResults.map((item) => (
              <ProblemItem key={`search-${item.type}-${item.id}`} item={item} onFix={setSelected} />
            ))}
          </div>
        )}
      </form>

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <SmallStat label="Sem capa/sinopse" value={data?.stats?.missing} />
        <SmallStat label="Titulos duplicados" value={data?.stats?.duplicateTitles} />
        <SmallStat label="Series suspeitas" value={data?.stats?.seriesIssues} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section>
          <h2 className="mb-3 text-xl font-black text-white">Sem capa ou sinopse</h2>
          <div className="space-y-2">
            {data?.missing?.map((item) => (
              <ProblemItem key={`${item.type}-${item.id}`} item={item} onFix={setSelected} />
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-xl font-black text-white">Duplicados provaveis</h2>
          <div className="space-y-2">
            {data?.duplicates?.map((item) => (
              <div key={item.normalizedTitle} className="rounded border border-white/10 bg-white/6 p-3">
                <p className="font-bold text-white">{item.normalizedTitle}</p>
                <p className="mt-1 text-sm text-slate-400">{item.total} itens</p>
                <p className="mt-2 line-clamp-3 text-sm text-slate-300">{item.titles}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-xl font-black text-white">Series suspeitas</h2>
          <div className="space-y-2">
            {data?.seriesIssues?.map((item) => (
              <ProblemItem key={`series-${item.id}`} item={item} onFix={setSelected} />
            ))}
          </div>
        </section>
      </div>

      <ManualTmdbModal item={selected} onClose={() => setSelected(null)} onApplied={refreshAfterApply} />
    </div>
  );
}
