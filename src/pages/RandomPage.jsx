import { Clapperboard, Dice5, Film, Play, RefreshCcw, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch, mediaLink, watchLink } from '../api.js';
import EmptyState from '../components/EmptyState.jsx';
import FavoriteButton from '../components/FavoriteButton.jsx';

const typeOptions = [
  { id: 'movie', label: 'Filme', icon: Film },
  { id: 'series', label: 'Serie', icon: Clapperboard }
];

const metadataOptions = [
  { id: 'all', label: 'Todos' },
  { id: 'withPoster', label: 'Com capa' },
  { id: 'withOverview', label: 'Com sinopse' },
  { id: 'missingAny', label: 'Faltando dados' }
];

export default function RandomPage() {
  const [type, setType] = useState('movie');
  const [category, setCategory] = useState('all');
  const [year, setYear] = useState('');
  const [metadata, setMetadata] = useState('all');
  const [categories, setCategories] = useState([]);
  const [item, setItem] = useState(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);

  const currentTypeLabel = typeOptions.find((option) => option.id === type)?.label || 'Titulo';
  const filteredCategories = useMemo(
    () => categories.filter((entry) => entry.type === type),
    [categories, type]
  );

  useEffect(() => {
    apiFetch('/categories', { cacheTtlMs: 1000 * 60 * 5 })
      .then((data) => setCategories(data.categories || []))
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    setCategory('all');
    setItem(null);
    setTotal(0);
    setHasDrawn(false);
  }, [type]);

  async function draw() {
    setBusy(true);
    setError('');
    setHasDrawn(true);
    try {
      const params = new URLSearchParams({
        type,
        category,
        metadata
      });
      if (year.trim()) params.set('year', year.trim());
      const data = await apiFetch(`/random-pick?${params.toString()}`);
      setItem(data.item || null);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-4xl font-black text-white">Sorteador</h1>
          <p className="mt-2 text-sm text-slate-400">Escolha o tipo, filtre a categoria e deixe a biblioteca decidir.</p>
        </div>
        <button
          type="button"
          onClick={draw}
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 rounded bg-brand px-5 py-3 text-sm font-black text-white shadow-glow hover:bg-red-600 disabled:cursor-wait disabled:opacity-70"
        >
          {busy ? <RefreshCcw size={18} className="animate-spin" /> : <Dice5 size={18} />}
          {hasDrawn ? 'Sortear novamente' : 'Sortear agora'}
        </button>
      </div>

      <section className="mb-6 grid gap-3 rounded border border-white/10 bg-white/6 p-4 md:grid-cols-[auto,1fr,0.7fr,0.8fr]">
        <div className="flex rounded border border-white/10 bg-black/20 p-1">
          {typeOptions.map(({ id, label, icon: Icon }) => {
            const active = type === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setType(id)}
                className={`inline-flex items-center gap-2 rounded px-4 py-2 text-sm font-black transition ${
                  active ? 'bg-white text-ink' : 'text-slate-300 hover:bg-white/8 hover:text-white'
                }`}
              >
                <Icon size={17} />
                {label}
              </button>
            );
          })}
        </div>

        <label className="flex items-center gap-2 rounded border border-white/10 bg-black/20 px-3 py-2">
          <Sparkles size={17} className="text-slate-400" />
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="w-full bg-transparent text-sm font-bold text-white outline-none"
          >
            <option value="all" className="bg-ink">Todas as categorias</option>
            {filteredCategories.map((entry) => (
              <option key={`${entry.type}-${entry.id}`} value={entry.id} className="bg-ink">
                {entry.name} ({entry.total})
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 rounded border border-white/10 bg-black/20 px-3 py-2">
          <Search size={17} className="text-slate-400" />
          <input
            value={year}
            onChange={(event) => setYear(event.target.value.replace(/\D/g, '').slice(0, 4))}
            className="w-full bg-transparent text-sm font-bold text-white outline-none placeholder:text-slate-500"
            placeholder="Ano"
            inputMode="numeric"
          />
        </label>

        <label className="flex items-center gap-2 rounded border border-white/10 bg-black/20 px-3 py-2">
          <select
            value={metadata}
            onChange={(event) => setMetadata(event.target.value)}
            className="w-full bg-transparent text-sm font-bold text-white outline-none"
          >
            {metadataOptions.map((option) => (
              <option key={option.id} value={option.id} className="bg-ink">
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {error && <p className="mb-5 rounded border border-red-400/20 bg-red-950/30 px-3 py-2 text-sm text-red-200">{error}</p>}

      {item ? (
        <section className="grid gap-6 overflow-hidden rounded border border-white/10 bg-white/6 md:grid-cols-[minmax(220px,320px),1fr]">
          <div className="aspect-[2/3] bg-black/30 md:aspect-auto">
            {item.posterUrl ? (
              <img src={item.posterUrl} alt={item.title} className="size-full object-cover" />
            ) : (
              <div className="grid size-full place-items-center bg-gradient-to-br from-brand/70 to-ocean/70 p-8 text-center">
                <Film size={56} />
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col justify-center p-5 sm:p-8">
            <p className="text-xs font-black uppercase text-ocean">{currentTypeLabel} sorteado</p>
            <h2 className="mt-2 text-3xl font-black text-white sm:text-5xl">{item.title}</h2>
            <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold text-slate-300">
              {item.category && <span className="rounded bg-white/10 px-2 py-1">{item.category}</span>}
              {(item.releaseYear || item.firstAirYear) && <span className="rounded bg-white/10 px-2 py-1">{item.releaseYear || item.firstAirYear}</span>}
              {type === 'series' && <span className="rounded bg-white/10 px-2 py-1">{item.episodeCount || 0} episodio(s)</span>}
              {total > 0 && <span className="rounded bg-white/10 px-2 py-1">{total} candidato(s)</span>}
            </div>
            {item.overview && <p className="mt-5 line-clamp-5 max-w-3xl text-sm leading-6 text-slate-300">{item.overview}</p>}

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link to={watchLink(item)} className="inline-flex items-center gap-2 rounded bg-white px-5 py-3 text-sm font-black text-ink hover:bg-slate-200">
                <Play size={17} fill="currentColor" />
                Assistir
              </Link>
              <Link to={mediaLink(item)} className="inline-flex items-center gap-2 rounded border border-white/10 px-5 py-3 text-sm font-bold text-slate-200 hover:bg-white/8">
                Detalhes
              </Link>
              <FavoriteButton type={item.type} id={item.id} initial={item.isFavorite} />
            </div>
          </div>
        </section>
      ) : hasDrawn && !busy ? (
        <EmptyState title="Nada encontrado" description="Tente outra categoria, remova o ano ou troque o tipo." />
      ) : (
        <div className="grid min-h-80 place-items-center rounded border border-dashed border-white/12 bg-white/4 p-8 text-center">
          <div>
            <Dice5 size={48} className="mx-auto text-ocean" />
            <p className="mt-4 text-lg font-black text-white">Pronto para sortear</p>
            <p className="mt-2 text-sm text-slate-400">A surpresa aparece aqui.</p>
          </div>
        </div>
      )}
    </div>
  );
}
