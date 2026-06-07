import { Info, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch, mediaLink, watchLink } from '../api.js';
import ContentRow from '../components/ContentRow.jsx';
import EmptyState from '../components/EmptyState.jsx';
import FavoriteButton from '../components/FavoriteButton.jsx';

function typeLabel(type) {
  if (type === 'movie') return 'Filme';
  if (type === 'series') return 'Serie';
  if (type === 'channel') return 'Canal';
  return 'Destaque';
}

function heroEyebrow(item) {
  const completed = Number(item?.completedCount || 0);
  const watched = Number(item?.watchCount || 0);
  if (completed > 0 || watched > 0) return 'Top 10 mais assistidos';
  return 'Adicionado recentemente';
}

function heroMeta(item) {
  const completed = Number(item?.completedCount || 0);
  const watched = Number(item?.watchCount || 0);
  const parts = [typeLabel(item?.type), item?.category, item?.releaseYear || item?.firstAirYear].filter(Boolean);
  if (completed > 0) parts.push(`${completed} finalizacao${completed === 1 ? '' : 'es'}`);
  else if (watched > 0) parts.push(`${watched} reproduc${watched === 1 ? 'ao' : 'oes'}`);
  return parts;
}

export default function Home() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [featuredIndex, setFeaturedIndex] = useState(0);

  useEffect(() => {
    apiFetch('/home')
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    setFeaturedIndex(0);
  }, [data?.featuredItems]);

  useEffect(() => {
    const total = data?.featuredItems?.length || 0;
    if (total < 2) return undefined;

    const timer = window.setInterval(() => {
      setFeaturedIndex((current) => (current + 1) % total);
    }, 7000);

    return () => window.clearInterval(timer);
  }, [data?.featuredItems]);

  if (error) return <EmptyState title={error} />;
  if (!data) return <div className="mx-auto max-w-7xl px-4 py-24 text-slate-300">Carregando...</div>;

  const hasLibrary = data.stats.movies || data.stats.series || data.stats.channels;
  if (!hasLibrary) {
    return <EmptyState title="Sua biblioteca esta vazia" action={{ to: '/admin', label: 'Abrir admin' }} />;
  }

  const featuredItems = data.featuredItems?.length ? data.featuredItems : data.featured ? [data.featured] : [];
  const featured = featuredItems[featuredIndex % featuredItems.length];

  function updateFavoriteInHome(target, next) {
    const updateItem = (item) => (
      item?.type === target?.type && item?.id === target?.id ? { ...item, isFavorite: next } : item
    );
    const updateItems = (items) => items?.map(updateItem) || items;

    setData((current) => current ? {
      ...current,
      featured: updateItem(current.featured),
      featuredItems: updateItems(current.featuredItems),
      trending: updateItems(current.trending),
      continueWatching: updateItems(current.continueWatching),
      continueMoviesSeries: updateItems(current.continueMoviesSeries),
      continueChannels: updateItems(current.continueChannels),
      favorites: next
        ? updateItems(current.favorites)
        : current.favorites?.filter((item) => !(item.type === target.type && item.id === target.id)),
      popularMovies: updateItems(current.popularMovies),
      popularSeries: updateItems(current.popularSeries),
      popularChannels: updateItems(current.popularChannels),
      randomMovies: updateItems(current.randomMovies),
      randomSeries: updateItems(current.randomSeries),
      liveChannels: updateItems(current.liveChannels),
      rows: current.rows?.map((row) => ({ ...row, items: updateItems(row.items) }))
    } : current);
  }

  return (
    <div>
      {featured && (
        <section className="relative -mt-24 min-h-[74vh] overflow-hidden">
          {(featured.backdropUrl || featured.posterUrl) && (
            <img src={featured.backdropUrl || featured.posterUrl} alt={featured.title} className="absolute inset-0 size-full object-cover opacity-42" />
          )}
          <div className="absolute inset-0 bg-[linear-gradient(90deg,#08090d_0%,rgba(8,9,13,0.88)_36%,rgba(8,9,13,0.32)_100%)]" />
          <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-ink to-transparent" />

          <div className="relative mx-auto flex min-h-[74vh] max-w-7xl flex-col justify-end px-4 pb-16 pt-32 sm:px-6 lg:px-8">
            <div className="max-w-2xl">
              <p className="mb-3 inline-flex rounded bg-brand px-3 py-1 text-xs font-black uppercase tracking-wide text-white">
                {heroEyebrow(featured)}
              </p>
              <h1 className="text-4xl font-black leading-tight text-white sm:text-6xl">{featured.title}</h1>
              <div className="mt-4 flex flex-wrap gap-2">
                {heroMeta(featured).map((part) => (
                  <span key={`${featured.type}-${featured.id}-${part}`} className="rounded-full border border-white/12 bg-white/10 px-3 py-1 text-xs font-bold text-white/88 backdrop-blur">
                    {part}
                  </span>
                ))}
              </div>
              <p className="mt-4 line-clamp-3 max-w-xl text-base text-slate-300 sm:text-lg">
                {featured.overview || 'Conteudo importado da sua playlist local, pronto para assistir e continuar depois.'}
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link
                  to={watchLink(featured)}
                  className="inline-flex items-center gap-2 rounded bg-white px-5 py-3 text-sm font-black text-ink hover:bg-slate-200"
                >
                  <Play size={18} fill="currentColor" />
                  Assistir
                </Link>
                <Link
                  to={mediaLink(featured)}
                  className="inline-flex items-center gap-2 rounded bg-white/12 px-5 py-3 text-sm font-bold text-white hover:bg-white/18"
                >
                  <Info size={18} />
                  Detalhes
                </Link>
                <FavoriteButton
                  type={featured.type}
                  id={featured.id}
                  initial={featured.isFavorite}
                  label
                  onChange={(next) => updateFavoriteInHome(featured, next)}
                  className="border-white/20"
                />
              </div>
              {featuredItems.length > 1 && (
                <div className="mt-7 flex gap-2">
                  {featuredItems.map((item, index) => (
                    <button
                      key={`${item.type}-${item.id}`}
                      onClick={() => setFeaturedIndex(index)}
                      className={`h-1.5 rounded-full transition-all ${index === featuredIndex ? 'w-9 bg-white' : 'w-4 bg-white/34 hover:bg-white/60'}`}
                      aria-label={`Mostrar destaque ${index + 1}`}
                      title={item.title}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
        <ContentRow title="Continue assistindo filmes e series" items={data.continueMoviesSeries || data.continueWatching} onFavoriteChange={updateFavoriteInHome} />
        <ContentRow title="Continue assistindo canais" items={data.continueChannels} onFavoriteChange={updateFavoriteInHome} />
        <ContentRow title="Top 10 da biblioteca" items={data.trending} onFavoriteChange={updateFavoriteInHome} />
        <ContentRow title="Filmes mais assistidos" items={data.popularMovies || data.randomMovies || data.recentMovies} onFavoriteChange={updateFavoriteInHome} />
        <ContentRow title="Series mais assistidas" items={data.popularSeries || data.randomSeries || data.recentSeries} onFavoriteChange={updateFavoriteInHome} />
        <ContentRow title="Canais em alta" items={data.popularChannels || data.liveChannels} onFavoriteChange={updateFavoriteInHome} />
        <ContentRow title="Meus favoritos" items={data.favorites} onFavoriteChange={updateFavoriteInHome} />
        {data.rows.map((row) => (
          <ContentRow key={`${row.type}-${row.title}`} title={row.title} items={row.items} onFavoriteChange={updateFavoriteInHome} />
        ))}
      </div>
    </div>
  );
}
