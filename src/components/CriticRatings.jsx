export default function CriticRatings({ ratings = [] }) {
  if (!ratings.length) return null;

  return (
    <div className="mt-6 max-w-3xl">
      <p className="mb-3 text-sm font-black uppercase tracking-wide text-slate-300">Avaliacoes da critica</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {ratings.map((rating) => (
          <div key={rating.id || rating.label} className="rounded border border-white/10 bg-black/18 px-4 py-3 shadow-lg shadow-black/10">
            <p className="text-[11px] font-black uppercase tracking-[0.24em] text-ocean">{rating.label}</p>
            <p className="mt-2 text-2xl font-black text-white">{rating.value}</p>
            {rating.detail ? <p className="mt-1 text-xs text-slate-400">{rating.detail}</p> : <div className="mt-1 h-[18px]" />}
          </div>
        ))}
      </div>
    </div>
  );
}
