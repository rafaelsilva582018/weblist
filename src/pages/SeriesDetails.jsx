import { ArrowLeft, Pencil, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiFetch } from '../api.js';
import EmptyState from '../components/EmptyState.jsx';
import ManualTmdbModal from '../components/ManualTmdbModal.jsx';

export default function SeriesDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [series, setSeries] = useState(null);
  const [selectedSeason, setSelectedSeason] = useState(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');

  function loadSeries() {
    setError('');
    apiFetch(`/series/${id}`)
      .then((data) => {
        setSeries(data.series);
        setSelectedSeason((current) => (
          data.series.seasons?.some((season) => season.id === current) ? current : data.series.seasons?.[0]?.id || null
        ));
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    loadSeries();
  }, [id]);

  const currentSeason = useMemo(() => {
    return series?.seasons?.find((season) => season.id === selectedSeason) || series?.seasons?.[0];
  }, [selectedSeason, series]);

  if (error) return <EmptyState title={error} />;
  if (!series) return <div className="mx-auto max-w-7xl px-4 py-24 text-slate-300">Carregando...</div>;

  return (
    <div>
      <section className="relative -mt-24 overflow-hidden">
        {(series.backdropUrl || series.posterUrl) && <img src={series.backdropUrl || series.posterUrl} alt={series.title} className="absolute inset-0 size-full object-cover opacity-24" />}
        <div className="absolute inset-0 bg-[linear-gradient(90deg,#08090d_0%,rgba(8,9,13,0.92)_55%,rgba(8,9,13,0.64)_100%)]" />
        <div className="relative mx-auto max-w-7xl px-4 pb-14 pt-32 sm:px-6 lg:px-8">
          <button onClick={() => navigate(-1)} className="mb-8 inline-flex items-center gap-2 rounded bg-white/8 px-3 py-2 text-sm text-slate-200 hover:bg-white/12">
            <ArrowLeft size={17} />
            Voltar
          </button>
          {series.category && <p className="mb-3 text-sm font-bold uppercase tracking-wide text-ocean">{series.category}</p>}
          <h1 className="max-w-4xl text-4xl font-black leading-tight text-white sm:text-6xl">{series.title}</h1>
          <div className="mt-5 max-w-2xl">
            <h2 className="mb-2 text-lg font-black text-white">Sinopse</h2>
            <p className="text-slate-300">{series.overview || 'Sinopse ainda nao importada do TMDB.'}</p>
          </div>
          <p className="mt-3 text-sm text-slate-400">
            {series.seasons.length} temporadas{series.firstAirYear ? ` - ${series.firstAirYear}` : ''}
          </p>
          <button onClick={() => setEditing(true)} className="mt-8 inline-flex items-center gap-2 rounded bg-white/10 px-5 py-3 text-sm font-bold text-white hover:bg-white/16">
            <Pencil size={17} />
            Editar
          </button>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
        <div className="no-scrollbar mb-6 flex gap-2 overflow-x-auto">
          {series.seasons.map((season) => (
            <button
              key={season.id}
              onClick={() => setSelectedSeason(season.id)}
              className={`shrink-0 rounded px-4 py-2 text-sm font-bold ${
                currentSeason?.id === season.id ? 'bg-white text-ink' : 'bg-white/8 text-slate-200 hover:bg-white/12'
              }`}
            >
              {season.title}
            </button>
          ))}
        </div>

        <div className="divide-y divide-white/10 overflow-hidden rounded border border-white/10 bg-white/5">
          {currentSeason?.episodes?.map((episode) => (
            <Link key={episode.id} to={`/watch/episode/${episode.id}`} className="flex items-center gap-4 p-4 transition hover:bg-white/8">
              <div className="grid size-12 shrink-0 place-items-center rounded bg-white text-ink">
                <Play size={18} fill="currentColor" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-white">
                  {episode.episodeNumber}. {episode.title}
                </p>
                <p className="mt-1 truncate text-sm text-slate-400">{episode.displayTitle}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>
      <ManualTmdbModal item={editing ? series : null} title="Editar serie" onClose={() => setEditing(false)} onApplied={loadSeries} />
    </div>
  );
}
