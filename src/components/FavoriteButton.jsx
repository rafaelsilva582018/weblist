import { Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';

const supportedTypes = new Set(['movie', 'series', 'channel']);

export default function FavoriteButton({ type, id, initial = false, onChange, className = '', label = false, size = 'normal' }) {
  const [isFavorite, setIsFavorite] = useState(Boolean(initial));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setIsFavorite(Boolean(initial));
  }, [initial, type, id]);

  if (!supportedTypes.has(type) || !id) return null;

  async function toggleFavorite(event) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;

    const next = !isFavorite;
    setIsFavorite(next);
    setBusy(true);
    try {
      if (next) {
        await apiFetch('/favorites', {
          method: 'POST',
          body: { type, id }
        });
      } else {
        await apiFetch(`/favorites/${type}/${id}`, { method: 'DELETE' });
      }
      onChange?.(next);
    } catch {
      setIsFavorite(!next);
    } finally {
      setBusy(false);
    }
  }

  const compact = size === 'small' && !label;
  const iconSize = compact ? 14 : 18;

  return (
    <button
      type="button"
      onClick={toggleFavorite}
      disabled={busy}
      aria-pressed={isFavorite}
      title={isFavorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
      className={`inline-flex items-center justify-center gap-2 rounded border border-white/10 backdrop-blur transition disabled:opacity-60 ${
        isFavorite
          ? 'bg-amber-400 text-ink hover:bg-amber-300'
          : 'bg-black/58 text-white hover:bg-white hover:text-ink'
      } ${label ? 'px-4 py-3 text-sm font-black' : compact ? 'size-8' : 'size-10'} ${className}`}
    >
      <Star size={iconSize} fill={isFavorite ? 'currentColor' : 'none'} />
      {label && <span>{isFavorite ? 'Favorito' : 'Favoritar'}</span>}
    </button>
  );
}
