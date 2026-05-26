import { Info, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch, mediaLink, watchLink } from '../api.js';
import ContentRow from '../components/ContentRow.jsx';
import EmptyState from '../components/EmptyState.jsx';

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
                Destaque
              </p>
              <h1 className="text-4xl font-black leading-tight text-white sm:text-6xl">{featured.title}</h1>
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
        <ContentRow title="Continue assistindo" items={data.continueWatching} />
        <ContentRow title="Filmes recentes" items={data.recentMovies} />
        <ContentRow title="Series recentes" items={data.recentSeries} />
        <ContentRow title="Canais ao vivo" items={data.liveChannels} />
        {data.rows.map((row) => (
          <ContentRow key={`${row.type}-${row.title}`} title={row.title} items={row.items} />
        ))}
      </div>
    </div>
  );
}
