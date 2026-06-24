import { ArrowLeft, Check, CheckCircle2, Pencil, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiFetch } from '../api.js';
import CriticRatings from '../components/CriticRatings.jsx';
import EmptyState from '../components/EmptyState.jsx';
import FavoriteButton from '../components/FavoriteButton.jsx';
import ManualTmdbModal from '../components/ManualTmdbModal.jsx';
import { useAuth } from '../context/AuthContext.jsx';

function episodeProgress(episode) {
  if (!episode?.progressDuration || episode.progressDuration <= 0) return 0;
  return Math.min(100, Math.max(0, (episode.progressPosition / episode.progressDuration) * 100));
}

function pickPrioritySeasonId(series) {
  const seasons = series?.seasons || [];
  if (!seasons.length) return null;

  for (let index = seasons.length - 1; index >= 0; index -= 1) {
    const season = seasons[index];
    if (season.episodes?.some((episode) => !episode.completedAt && Number(episode.progressPosition || 0) > 0)) {
      return season.id;
    }
  }

  for (const season of seasons) {
    if (season.episodes?.some((episode) => !episode.completedAt)) {
      return season.id;
    }
  }

  return seasons[seasons.length - 1]?.id || seasons[0]?.id || null;
}

export default function SeriesDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [series, setSeries] = useState(null);
  const [selectedSeason, setSelectedSeason] = useState(null);
  const [editing, setEditing] = useState(false);
  const [episodeBusyId, setEpisodeBusyId] = useState(null);
  const [error, setError] = useState('');

  function loadSeries() {
    setError('');
    apiFetch(`/series/${id}`, { cacheTtlMs: 30000 })
      .then((data) => {
        setSeries(data.series);
        setSelectedSeason((current) => (
          data.series.seasons?.some((season) => season.id === current) ? current : pickPrioritySeasonId(data.series)
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

  async function toggleEpisodeWatched(event, episode) {
    event.preventDefault();
    event.stopPropagation();
    const nextCompleted = !Boolean(episode.completedAt);
    setEpisodeBusyId(episode.id);
    try {
      const data = await apiFetch('/progress/status', {
        method: 'PUT',
        body: {
          type: 'episode',
          id: episode.id,
          completed: nextCompleted,
          duration: episode.progressDuration || 0
        }
      });

      setSeries((current) => current ? {
        ...current,
        seasons: current.seasons.map((season) => (
          season.id !== currentSeason?.id
            ? season
            : {
                ...season,
                episodes: season.episodes.map((item) => (
                  item.id !== episode.id
                    ? item
                    : {
                        ...item,
                        completedAt: data.progress?.completed_at || null,
                        progressPosition: nextCompleted ? (item.progressDuration || 1) : 0,
                        progressDuration: nextCompleted ? (item.progressDuration || 1) : 0
                      }
                ))
              }
        ))
      } : current);
    } catch (err) {
      setError(err.message);
    } finally {
      setEpisodeBusyId(null);
    }
  }

  if (error) return <EmptyState title={error} />;
  if (!series) return <div className="mx-auto max-w-7xl px-4 py-24 text-slate-300">Carregando...</div>;
  const isAdmin = Boolean(user?.isAdmin);

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
          <CriticRatings ratings={series.ratings || []} />
          <p className="mt-3 text-sm text-slate-400">
            {series.seasons.length} temporadas{series.firstAirYear ? ` - ${series.firstAirYear}` : ''}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            {isAdmin && (
              <button onClick={() => setEditing(true)} className="inline-flex items-center gap-2 rounded bg-white/10 px-5 py-3 text-sm font-bold text-white hover:bg-white/16">
                <Pencil size={17} />
                Editar
              </button>
            )}
            <FavoriteButton
              type="series"
              id={series.id}
              initial={series.isFavorite}
              label
              onChange={(next) => setSeries((current) => current ? { ...current, isFavorite: next } : current)}
            />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-wrap gap-2">
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
          {currentSeason?.episodes?.map((episode) => {
            const watched = Boolean(episode.completedAt);
            const percent = episodeProgress(episode);
            return (
              <div key={episode.id} className="group flex items-center gap-3 p-4 transition hover:bg-white/8">
                <Link to={`/watch/episode/${episode.id}`} className="flex min-w-0 flex-1 items-center gap-4">
                  <div className="relative grid h-16 w-24 shrink-0 place-items-center overflow-hidden rounded bg-white/8 text-white sm:w-28">
                    {episode.posterUrl ? (
                      <img src={episode.posterUrl} alt={episode.title} className="size-full object-cover" loading="lazy" />
                    ) : (
                      <Play size={18} fill="currentColor" />
                    )}
                    <span className="absolute inset-0 grid place-items-center bg-black/18 opacity-0 transition group-hover:opacity-100">
                      <span className="grid size-9 place-items-center rounded-full bg-white text-ink">
                        <Play size={16} fill="currentColor" />
                      </span>
                    </span>
                    {watched && (
                      <span className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-ocean text-ink shadow">
                        <CheckCircle2 size={15} />
                      </span>
                    )}
                    {!watched && percent > 0 && (
                      <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
                        <div className="h-full bg-brand" style={{ width: `${percent}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 truncate font-bold text-white">
                        {episode.episodeNumber}. {episode.title}
                      </p>
                      {watched && <span className="shrink-0 rounded bg-ocean/18 px-2 py-1 text-[11px] font-black uppercase text-ocean">Assistido</span>}
                    </div>
                    <p className="mt-1 truncate text-sm text-slate-400">
                      {episode.displayTitle}
                      {episode.sourceCount > 1 ? ` - ${episode.sourceCount} opcoes` : ''}
                    </p>
                  </div>
                </Link>
                <button
                  type="button"
                  onClick={(event) => toggleEpisodeWatched(event, episode)}
                  disabled={episodeBusyId === episode.id}
                  title={watched ? 'Desmarcar como assistido' : 'Marcar como assistido'}
                  className={`grid size-10 shrink-0 place-items-center rounded-full border text-sm font-black transition disabled:opacity-60 ${
                    watched
                      ? 'border-ocean/40 bg-ocean/18 text-ocean hover:bg-ocean/24'
                      : 'border-white/10 bg-white/8 text-white hover:bg-white/14'
                  }`}
                >
                  <Check size={18} strokeWidth={3} />
                </button>
              </div>
            );
          })}
        </div>
      </section>
      <ManualTmdbModal item={isAdmin && editing ? series : null} title="Editar serie" onClose={() => setEditing(false)} onApplied={loadSeries} />
    </div>
  );
}
