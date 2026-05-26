import { Check, Image, Search, Upload, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';

export default function ManualTmdbModal({ item, onClose, onApplied, title = 'Corrigir TMDB' }) {
  const [query, setQuery] = useState(item?.title || '');
  const [mode, setMode] = useState('tmdb');
  const [manual, setManual] = useState({ title: '', overview: '', posterUrl: '', backdropUrl: '' });
  const [imageFile, setImageFile] = useState(null);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setQuery(item?.title || '');
    setMode(item?.type === 'channel' ? 'manual' : 'tmdb');
    setManual({
      title: item?.title || '',
      overview: item?.overview || '',
      posterUrl: item?.posterUrl || '',
      backdropUrl: item?.backdropUrl || ''
    });
    setImageFile(null);
    setResults([]);
    setMessage('');
  }, [item]);

  if (!item) return null;

  async function search(event) {
    event?.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setMessage('');
    try {
      const data = await apiFetch(`/tmdb/search?type=${item.type}&q=${encodeURIComponent(query.trim())}`);
      setResults(data.items || []);
      if (!data.items?.length) setMessage('Nenhum resultado encontrado');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function apply(result) {
    setLoading(true);
    setMessage('');
    try {
      await apiFetch('/tmdb/apply', {
        method: 'POST',
        body: { type: item.type, id: item.id, tmdbId: result.tmdbId, force: true }
      });
      onApplied?.();
      onClose();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function saveManual(event) {
    event?.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      await apiFetch(`/admin/media/${item.type}/${item.id}`, {
        method: 'PATCH',
        body: manual
      });

      if (imageFile) {
        const form = new FormData();
        form.append('image', imageFile);
        await apiFetch(`/admin/media/${item.type}/${item.id}/image`, {
          method: 'POST',
          body: form
        });
      }

      onApplied?.();
      onClose();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }

  const canUseTmdb = item.type === 'movie' || item.type === 'series';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/76 p-4 backdrop-blur">
      <div className="max-h-[88vh] w-full max-w-4xl overflow-hidden rounded border border-white/10 bg-panel shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 p-4">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-black text-white">{title}</h2>
            <p className="truncate text-sm text-slate-400">{item.title}</p>
          </div>
          <button onClick={onClose} className="grid size-10 place-items-center rounded bg-white/8 text-white hover:bg-white/12" title="Fechar">
            <X size={18} />
          </button>
        </div>

        <div className="p-4">
          <div className="mb-4 grid grid-cols-2 overflow-hidden rounded border border-white/10 bg-black/18 p-1">
            <button
              type="button"
              disabled={!canUseTmdb}
              onClick={() => setMode('tmdb')}
              className={`rounded px-3 py-2 text-sm font-bold disabled:opacity-40 ${mode === 'tmdb' ? 'bg-white text-ink' : 'text-slate-300 hover:bg-white/8'}`}
            >
              TMDB
            </button>
            <button
              type="button"
              onClick={() => setMode('manual')}
              className={`rounded px-3 py-2 text-sm font-bold ${mode === 'manual' ? 'bg-white text-ink' : 'text-slate-300 hover:bg-white/8'}`}
            >
              Manual
            </button>
          </div>

          {message && <p className="mt-3 text-sm text-slate-300">{message}</p>}

          {mode === 'tmdb' && canUseTmdb && (
            <>
              <form onSubmit={search} className="flex gap-2">
                <label className="flex flex-1 items-center gap-2 rounded border border-white/10 bg-black/24 px-3 py-2">
                  <Search size={17} className="text-muted" />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} className="w-full bg-transparent text-white outline-none" />
                </label>
                <button disabled={loading} className="rounded bg-white px-4 py-2 text-sm font-black text-ink disabled:opacity-60">
                  Buscar
                </button>
              </form>

              <div className="mt-4 grid max-h-[58vh] gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
                {results.map((result) => (
                  <button
                    key={result.tmdbId}
                    onClick={() => apply(result)}
                    disabled={loading}
                    className="flex gap-3 rounded border border-white/10 bg-white/6 p-3 text-left transition hover:bg-white/10 disabled:opacity-60"
                  >
                    <div className="h-28 w-20 shrink-0 overflow-hidden rounded bg-white/8">
                      {result.posterUrl ? <img src={result.posterUrl} alt={result.title} className="size-full object-cover" /> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 font-bold text-white">{result.title}</p>
                      <p className="mt-1 text-xs text-slate-400">
                        {result.releaseYear || result.firstAirYear || 'Sem ano'} - score {Math.round(result.score || 0)}
                      </p>
                      <p className="mt-2 line-clamp-3 text-sm text-slate-300">{result.overview || 'Sem sinopse'}</p>
                      <span className="mt-3 inline-flex items-center gap-1 rounded bg-ocean px-2 py-1 text-xs font-black text-ink">
                        <Check size={13} />
                        Usar este
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          {mode === 'manual' && (
            <form onSubmit={saveManual} className="grid max-h-[62vh] gap-3 overflow-y-auto pr-1">
              <label className="block">
                <span className="text-sm font-bold text-slate-200">Nome</span>
                <input
                  value={manual.title}
                  onChange={(event) => setManual((value) => ({ ...value, title: event.target.value }))}
                  className="mt-2 w-full rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none"
                />
              </label>

              {item.type !== 'channel' && (
                <label className="block">
                  <span className="text-sm font-bold text-slate-200">Sinopse</span>
                  <textarea
                    value={manual.overview}
                    onChange={(event) => setManual((value) => ({ ...value, overview: event.target.value }))}
                    className="mt-2 min-h-28 w-full rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none"
                  />
                </label>
              )}

              <label className="block">
                <span className="text-sm font-bold text-slate-200">{item.type === 'channel' ? 'URL do logo' : 'URL da capa'}</span>
                <input
                  value={manual.posterUrl}
                  onChange={(event) => setManual((value) => ({ ...value, posterUrl: event.target.value }))}
                  className="mt-2 w-full rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none"
                  placeholder="https://..."
                />
              </label>

              {item.type !== 'channel' && (
                <label className="block">
                  <span className="text-sm font-bold text-slate-200">URL do fundo</span>
                  <input
                    value={manual.backdropUrl}
                    onChange={(event) => setManual((value) => ({ ...value, backdropUrl: event.target.value }))}
                    className="mt-2 w-full rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none"
                    placeholder="https://..."
                  />
                </label>
              )}

              <label className="flex items-center gap-3 rounded border border-dashed border-white/18 bg-black/18 p-3 text-sm text-slate-200">
                <Image size={18} />
                <span className="min-w-0 flex-1 truncate">{imageFile?.name || 'Carregar imagem do computador'}</span>
                <input type="file" accept="image/*" onChange={(event) => setImageFile(event.target.files?.[0] || null)} className="hidden" />
              </label>

              <button disabled={loading} className="mt-2 inline-flex items-center justify-center gap-2 rounded bg-white px-4 py-3 text-sm font-black text-ink disabled:opacity-60">
                <Upload size={17} />
                Salvar manual
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
