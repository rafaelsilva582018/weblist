import { ArrowLeft, ChevronRight, Film, LayoutGrid, MonitorPlay, Search, Tv } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiFetch } from '../api.js';
import EmptyState from '../components/EmptyState.jsx';
import Pagination from '../components/Pagination.jsx';
import PosterCard from '../components/PosterCard.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const labels = {
  movie: { title: 'Filmes', singular: 'filme', plural: 'filmes', endpoint: '/movies', Icon: Film },
  series: { title: 'Series', singular: 'serie', plural: 'series', endpoint: '/series', Icon: MonitorPlay },
  channel: { title: 'Canais', singular: 'canal', plural: 'canais', endpoint: '/channels', Icon: Tv }
};

const categoryGradients = [
  'from-[#2f172f] via-[#8f2942] to-[#ef7d57]',
  'from-[#0f1f33] via-[#1f5f8b] to-[#67c6e3]',
  'from-[#132b1c] via-[#2d6a4f] to-[#95d5b2]',
  'from-[#27140e] via-[#8c3c13] to-[#f4a261]',
  'from-[#1f1d3a] via-[#4f46a5] to-[#8b5cf6]',
  'from-[#1a2330] via-[#384b63] to-[#9fb3c8]'
];

const posterDeckPositions = [
  'right-[5.8rem] top-4 z-10 rotate-[-11deg] group-hover:-translate-x-1',
  'right-3 top-7 z-30 rotate-[7deg] group-hover:-translate-y-1',
  'right-[7.5rem] top-24 z-0 rotate-[11deg] group-hover:translate-y-1',
  'right-0 top-[7.5rem] z-20 rotate-[-4deg] group-hover:translate-x-1'
];

const logoDeckPositions = [
  'right-[6rem] top-5 z-10 rotate-[-8deg] group-hover:-translate-x-1',
  'right-2 top-10 z-30 rotate-[5deg] group-hover:-translate-y-1',
  'right-[7.2rem] top-[6.8rem] z-0 rotate-[10deg] group-hover:translate-y-1',
  'right-1 top-[9rem] z-20 rotate-[-3deg] group-hover:translate-x-1'
];

function formatTotal(total = 0, singular = 'item', plural = 'itens') {
  return `${total} ${total === 1 ? singular : plural}`;
}

function buildCategorySubtitle(total, config) {
  return formatTotal(total, config.singular, config.plural);
}

function createNextParams(urlParams, mutate) {
  const next = new URLSearchParams(urlParams);
  mutate(next);
  return next;
}

function CategoryCard({ category, config, index, onOpen }) {
  const gradient = categoryGradients[index % categoryGradients.length];
  const Icon = config.Icon;
  const previewImages = (category.previewImages || []).filter((item) => item?.imageUrl).slice(0, 4);
  const heroUrl = previewImages.find((item) => item?.heroUrl)?.heroUrl || previewImages[0]?.imageUrl || '';
  const isChannel = config.endpoint === '/channels';
  const deckPositions = isChannel ? logoDeckPositions : posterDeckPositions;

  return (
    <button
      type="button"
      onClick={() => onOpen(category.id)}
      className="group relative isolate overflow-hidden rounded-[28px] border border-white/10 bg-panel/70 p-5 text-left transition hover:-translate-y-0.5 hover:border-white/20 hover:bg-panel"
    >
      {!isChannel && heroUrl && (
        <img
          src={heroUrl}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 size-full scale-110 object-cover opacity-28 blur-[2px] saturate-125 transition duration-500 group-hover:scale-[1.16] group-hover:opacity-36"
          loading="lazy"
        />
      )}
      <div className={`absolute inset-0 bg-gradient-to-br ${gradient} ${heroUrl && !isChannel ? 'opacity-70' : 'opacity-88'} transition group-hover:opacity-100`} />
      <div className="absolute inset-0 bg-[linear-gradient(110deg,rgba(6,8,12,0.94)_0%,rgba(6,8,12,0.82)_38%,rgba(6,8,12,0.26)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.2),transparent_35%)]" />

      {previewImages.length > 0 && (
        <div className="pointer-events-none absolute inset-y-0 right-0 w-[56%]">
          {previewImages.map((item, previewIndex) => (
            <div
              key={`${category.id}-${item.imageUrl}-${previewIndex}`}
              className={`absolute transition duration-300 ${deckPositions[previewIndex] || deckPositions[0]}`}
            >
              <img
                src={item.imageUrl}
                alt=""
                aria-hidden="true"
                loading="lazy"
                className={`h-28 w-20 rounded-2xl border border-white/10 bg-black/30 shadow-[0_18px_40px_rgba(0,0,0,0.42)] ${isChannel ? 'object-contain p-2' : 'object-cover'}`}
              />
            </div>
          ))}
        </div>
      )}

      <div className="relative flex min-h-[16rem] flex-col justify-between">
        <div className="flex items-start justify-between gap-4">
          <span className="grid size-12 place-items-center rounded-2xl bg-black/20 text-white ring-1 ring-white/10 backdrop-blur">
            <Icon size={22} />
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-black/25 px-3 py-1 text-xs font-bold text-white/90 ring-1 ring-white/10 backdrop-blur">
            {formatTotal(category.total || 0)}
          </span>
        </div>

        <div className="max-w-[58%]">
          <h2 className="line-clamp-2 text-[1.35rem] font-black leading-tight text-white">{category.name}</h2>
          <p className="mt-2 text-sm text-white/78">{buildCategorySubtitle(category.total || 0, config)}</p>
          {previewImages.length > 0 && (
            <p className="mt-3 line-clamp-2 text-xs leading-5 text-white/62">
              {previewImages.map((item) => item.title).filter(Boolean).slice(0, 2).join(' • ')}
            </p>
          )}
        </div>

        <div className="mt-5 flex items-center gap-2 text-sm font-bold text-white">
          Abrir categoria
          <ChevronRight size={16} className="transition group-hover:translate-x-0.5" />
        </div>
      </div>
    </button>
  );
}

export default function CatalogPage({ type }) {
  const config = labels[type];
  const { user } = useAuth();
  const [urlParams, setUrlParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const query = urlParams.get('q') || '';
  const category = urlParams.get('category') || 'all';
  const sort = urlParams.get('sort') || 'imported';
  const metadata = urlParams.get('metadata') || 'all';
  const year = urlParams.get('year') || '';
  const view = urlParams.get('view') || '';
  const canViewAdult = Boolean(user?.canViewAdult);
  const hideAdultParam = urlParams.get('hideAdult');
  const hideAdult = !canViewAdult || (hideAdultParam === null ? user?.preferHideAdult !== false : hideAdultParam !== 'false');
  const page = Math.max(1, Number(urlParams.get('page') || 1) || 1);

  const showCategoryLanding = !query.trim()
    && category === 'all'
    && sort === 'imported'
    && page === 1
    && view !== 'items'
    && (type === 'channel' || (metadata === 'all' && !year.trim()));

  const requestParams = useMemo(() => {
    const params = new URLSearchParams({ sort, page: String(page), limit: type === 'channel' ? '96' : '60' });
    if (query.trim()) params.set('q', query.trim());
    if (category !== 'all') params.set('category', category);
    params.set('hideAdult', hideAdult ? 'true' : 'false');
    if (type !== 'channel') {
      if (metadata !== 'all') params.set('metadata', metadata);
      if (year.trim()) params.set('year', year.trim());
    }
    return params.toString();
  }, [category, hideAdult, metadata, page, query, sort, type, year]);

  useEffect(() => {
    if (showCategoryLanding) {
      setLoading(false);
      setError('');
      setPagination(null);
      return;
    }

    setLoading(true);
    apiFetch(`${config.endpoint}?${requestParams}`)
      .then((data) => {
        setItems(data.items || []);
        setPagination(data.pagination || null);
        setError('');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [config.endpoint, requestParams, showCategoryLanding]);

  useEffect(() => {
    setCategoriesLoading(true);
    apiFetch(`/categories?type=${type}&hideAdult=${hideAdult ? 'true' : 'false'}`)
      .then((data) => setCategories(data.categories || []))
      .catch(() => setCategories([]))
      .finally(() => setCategoriesLoading(false));
  }, [hideAdult, type]);

  const visibleCategories = hideAdult
    ? categories.filter((item) => !/adult|xxx/i.test(item.name))
    : categories;

  const selectedCategory = useMemo(() => (
    visibleCategories.find((item) => String(item.id) === category || item.name === category) || null
  ), [category, visibleCategories]);

  function commitParams(next, options = {}) {
    setUrlParams(next, { replace: options.replace ?? false });
  }

  function updateParam(key, value, options = {}) {
    const next = createNextParams(urlParams, (params) => {
      const resetPage = options.resetPage !== false;
      const defaults = { category: 'all', sort: 'imported', metadata: 'all', hideAdult: 'true', page: '1' };
      const rawValue = String(value ?? '');
      const cleanValue = key === 'q' ? rawValue : rawValue.trim();

      if ((key === 'q' ? rawValue.length === 0 : !cleanValue) || cleanValue === defaults[key]) params.delete(key);
      else params.set(key, cleanValue);

      if (resetPage) params.delete('page');
      if (options.forceItemView) params.set('view', 'items');
      if (options.clearItemView) params.delete('view');
    });

    commitParams(next, { replace: options.replace ?? (options.resetPage !== false) });
  }

  function openCategory(categoryId) {
    const next = createNextParams(urlParams, (params) => {
      params.set('category', String(categoryId));
      params.delete('q');
      params.delete('page');
      params.delete('sort');
      params.delete('metadata');
      params.delete('year');
      params.delete('view');
    });
    commitParams(next);
  }

  function openAllItems() {
    const next = createNextParams(urlParams, (params) => {
      params.set('view', 'items');
      params.delete('q');
      params.delete('category');
      params.delete('page');
      params.delete('sort');
      params.delete('metadata');
      params.delete('year');
    });
    commitParams(next);
  }

  function openCategoryLanding() {
    const next = createNextParams(urlParams, (params) => {
      params.delete('q');
      params.delete('category');
      params.delete('page');
      params.delete('sort');
      params.delete('metadata');
      params.delete('year');
      params.delete('view');
    });
    commitParams(next);
  }

  function changePage(nextPage) {
    const next = createNextParams(urlParams, (params) => {
      if (nextPage <= 1) params.delete('page');
      else params.set('page', String(nextPage));
      if (view === 'items') params.set('view', 'items');
    });
    commitParams(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const itemCount = pagination?.total ?? items.length;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.28em] text-slate-500">
            {showCategoryLanding ? 'Escolha uma categoria' : config.title}
          </p>
          <h1 className="mt-2 text-4xl font-black text-white">
            {showCategoryLanding ? config.title : selectedCategory?.name || config.title}
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            {showCategoryLanding
              ? `${visibleCategories.length} categorias para explorar`
              : `${formatTotal(itemCount)}${selectedCategory ? ` em ${selectedCategory.name}` : ''}`}
          </p>
          {!showCategoryLanding && pagination && (
            <p className="mt-1 text-xs text-slate-500">
              Pagina {pagination.page} de {pagination.totalPages} - {pagination.total} no total
            </p>
          )}
        </div>

        <div className={`grid gap-3 ${showCategoryLanding ? 'sm:grid-cols-[minmax(240px,1fr)_160px]' : 'sm:grid-cols-[minmax(220px,1fr)_170px_160px]'}`}>
          <label className="flex items-center gap-2 rounded border border-white/10 bg-white/6 px-3 py-2">
            <Search size={17} className="text-muted" />
            <input
              value={query}
              onChange={(event) => updateParam('q', event.target.value, { forceItemView: Boolean(event.target.value.trim()) || view === 'items' })}
              className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-500"
              placeholder={type === 'channel' ? 'Buscar canal ou categoria' : 'Buscar titulo ou ano'}
            />
          </label>

          {showCategoryLanding ? (
            <button
              type="button"
              onClick={openAllItems}
              className="inline-flex items-center justify-center gap-2 rounded border border-white/10 bg-panel px-4 py-2 text-sm font-bold text-white transition hover:bg-white/10"
            >
              <LayoutGrid size={16} />
              Ver todos
            </button>
          ) : (
            <>
              <select
                value={category}
                onChange={(event) => updateParam('category', event.target.value, { forceItemView: event.target.value === 'all' })}
                className="rounded border border-white/10 bg-panel px-3 py-2 text-sm text-white"
              >
                <option value="all">Todas as categorias</option>
                {visibleCategories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <select value={sort} onChange={(event) => updateParam('sort', event.target.value, { forceItemView: true })} className="rounded border border-white/10 bg-panel px-3 py-2 text-sm text-white">
                <option value="imported">Recentes</option>
                <option value="name">Nome</option>
                <option value="category">Categoria</option>
                {type !== 'channel' && <option value="yearDesc">Ano mais novo</option>}
                {type !== 'channel' && <option value="yearAsc">Ano mais antigo</option>}
              </select>
            </>
          )}
        </div>
      </div>

      {(type !== 'channel' || canViewAdult) && (
        <div className={`mb-6 grid gap-3 rounded border border-white/10 bg-white/5 p-3 ${showCategoryLanding ? 'sm:grid-cols-[1fr]' : type === 'channel' ? 'sm:grid-cols-[150px_1fr]' : 'sm:grid-cols-[150px_180px_180px_1fr]'}`}>
          {!showCategoryLanding && (
            <button
              type="button"
              onClick={openCategoryLanding}
              className="inline-flex items-center justify-center gap-2 rounded border border-white/10 bg-panel px-3 py-2 text-sm font-bold text-white transition hover:bg-white/10"
            >
              <ArrowLeft size={16} />
              Categorias
            </button>
          )}

          {!showCategoryLanding && type !== 'channel' && (
            <>
              <select value={metadata} onChange={(event) => updateParam('metadata', event.target.value, { forceItemView: true })} className="rounded border border-white/10 bg-panel px-3 py-2 text-sm text-white">
                <option value="all">Metadados</option>
                <option value="missingAny">Sem capa/sinopse</option>
                <option value="missingPoster">Sem capa</option>
                <option value="withPoster">Com capa</option>
                <option value="missingOverview">Sem sinopse</option>
                <option value="withOverview">Com sinopse</option>
              </select>
              <input
                value={year}
                onChange={(event) => updateParam('year', event.target.value.replace(/\D/g, '').slice(0, 4), { forceItemView: true })}
                className="rounded border border-white/10 bg-panel px-3 py-2 text-sm text-white outline-none placeholder:text-slate-500"
                placeholder="Ano"
              />
            </>
          )}

          {canViewAdult && (
            <div className="grid grid-cols-2 overflow-hidden rounded border border-white/10 bg-panel p-1">
              <button
                type="button"
                onClick={() => updateParam('hideAdult', 'true', { resetPage: false, forceItemView: view === 'items' })}
                className={`rounded px-3 py-2 text-sm font-bold ${hideAdult ? 'bg-white text-ink' : 'text-slate-300 hover:bg-white/8'}`}
              >
                Ocultar adultos
              </button>
              <button
                type="button"
                onClick={() => updateParam('hideAdult', 'false', { resetPage: false, forceItemView: view === 'items' })}
                className={`rounded px-3 py-2 text-sm font-bold ${!hideAdult ? 'bg-white text-ink' : 'text-slate-300 hover:bg-white/8'}`}
              >
                Mostrar todos
              </button>
            </div>
          )}
        </div>
      )}

      {showCategoryLanding && categoriesLoading && <div className="py-20 text-slate-300">Carregando categorias...</div>}
      {showCategoryLanding && !categoriesLoading && !visibleCategories.length && <EmptyState title="Nenhuma categoria encontrada" />}
      {showCategoryLanding && !categoriesLoading && visibleCategories.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visibleCategories.map((item, index) => (
            <CategoryCard key={`${item.type}-${item.id}`} category={item} config={config} index={index} onOpen={openCategory} />
          ))}
        </div>
      )}

      {!showCategoryLanding && loading && <div className="py-20 text-slate-300">Carregando...</div>}
      {!showCategoryLanding && error && <EmptyState title={error} />}
      {!showCategoryLanding && !loading && !error && !items.length && <EmptyState title="Nada encontrado" />}
      {!showCategoryLanding && !loading && !error && items.length > 0 && (
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
