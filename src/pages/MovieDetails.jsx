import { ArrowLeft, Pencil, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiFetch } from '../api.js';
import EmptyState from '../components/EmptyState.jsx';
import FavoriteButton from '../components/FavoriteButton.jsx';
import ManualTmdbModal from '../components/ManualTmdbModal.jsx';

function sourceSummary(source, index) {
  const parts = [source?.quality, source?.language, source?.codec].filter(Boolean);
  return parts.join(' - ') || source?.label || `Opcao ${index + 1}`;
}

export default function MovieDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [movie, setMovie] = useState(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  function loadMovie() {
    setError('');
    apiFetch(`/movies/${id}`)
      .then((data) => setMovie(data.movie))
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    loadMovie();
  }, [id]);

  if (error) return <EmptyState title={error} />;
  if (!movie) return <div className="mx-auto max-w-7xl px-4 py-24 text-slate-300">Carregando...</div>;
  const sources = movie.sources || [];

  return (
    <div className="relative -mt-24 min-h-screen overflow-hidden">
      {(movie.backdropUrl || movie.posterUrl) && <img src={movie.backdropUrl || movie.posterUrl} alt={movie.title} className="absolute inset-0 size-full object-cover opacity-28" />}
      <div className="absolute inset-0 bg-[linear-gradient(90deg,#08090d_0%,rgba(8,9,13,0.92)_48%,rgba(8,9,13,0.68)_100%)]" />

      <div className="relative mx-auto grid min-h-screen max-w-7xl items-center gap-10 px-4 pb-14 pt-32 sm:px-6 lg:grid-cols-[320px,1fr] lg:px-8">
        <div className="hidden overflow-hidden rounded border border-white/10 bg-panel shadow-2xl lg:block">
          {movie.posterUrl ? (
            <img src={movie.posterUrl} alt={movie.title} className="aspect-[2/3] w-full object-cover" />
          ) : (
            <div className="grid aspect-[2/3] place-items-center bg-white/8 text-5xl font-black">W</div>
          )}
        </div>

        <div className="max-w-3xl">
          <button onClick={() => navigate(-1)} className="mb-8 inline-flex items-center gap-2 rounded bg-white/8 px-3 py-2 text-sm text-slate-200 hover:bg-white/12">
            <ArrowLeft size={17} />
            Voltar
          </button>
          {movie.category && <p className="mb-3 text-sm font-bold uppercase tracking-wide text-ocean">{movie.category}</p>}
          <h1 className="text-4xl font-black leading-tight text-white sm:text-6xl">{movie.title}</h1>
          <div className="mt-5 max-w-2xl">
            <h2 className="mb-2 text-lg font-black text-white">Sinopse</h2>
            <p className="text-slate-300">{movie.overview || 'Sinopse ainda nao importada do TMDB.'}</p>
          </div>
          {movie.releaseYear && <p className="mt-3 text-sm text-slate-400">{movie.releaseYear}</p>}
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to={`/watch/movie/${movie.id}`} className="inline-flex items-center gap-2 rounded bg-white px-6 py-3 text-sm font-black text-ink hover:bg-slate-200">
              <Play size={18} fill="currentColor" />
              Assistir
            </Link>
            <button onClick={() => setEditing(true)} className="inline-flex items-center gap-2 rounded bg-white/10 px-5 py-3 text-sm font-bold text-white hover:bg-white/16">
              <Pencil size={17} />
              Editar
            </button>
            <FavoriteButton
              type="movie"
              id={movie.id}
              initial={movie.isFavorite}
              label
              onChange={(next) => setMovie((current) => current ? { ...current, isFavorite: next } : current)}
            />
          </div>
          {sources.length > 1 && (
            <div className="mt-6 max-w-2xl">
              <p className="mb-2 text-sm font-black uppercase tracking-wide text-slate-300">Qualidade e idioma</p>
              <div className="flex flex-wrap gap-2">
                {sources.map((source, index) => (
                  <Link
                    key={source.id || `source-${index}`}
                    to={`/watch/movie/${movie.id}${source.id ? `?source=${source.id}` : ''}`}
                    className="rounded border border-white/10 bg-white/8 px-3 py-2 text-sm font-bold text-white hover:bg-white/14"
                  >
                    {sourceSummary(source, index)}
                    {source.sourceHost ? <span className="ml-2 text-xs font-semibold text-slate-400">{source.sourceHost}</span> : null}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <ManualTmdbModal item={editing ? movie : null} title="Editar filme" onClose={() => setEditing(false)} onApplied={loadMovie} />
    </div>
  );
}
