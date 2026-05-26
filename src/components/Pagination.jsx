import { ChevronLeft, ChevronRight } from 'lucide-react';

export default function Pagination({ pagination, onPage }) {
  if (!pagination || pagination.totalPages <= 1) return null;

  const page = pagination.page || 1;
  const totalPages = pagination.totalPages || 1;
  const pages = [];
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);

  for (let current = start; current <= end; current += 1) {
    pages.push(current);
  }

  return (
    <nav className="mt-8 flex flex-wrap items-center justify-center gap-2">
      <button
        onClick={() => onPage(page - 1)}
        disabled={!pagination.hasPrev}
        className="inline-flex items-center gap-2 rounded border border-white/10 px-3 py-2 text-sm font-bold text-slate-200 hover:bg-white/8 disabled:opacity-40"
      >
        <ChevronLeft size={17} />
        Anterior
      </button>

      {start > 1 && (
        <>
          <button onClick={() => onPage(1)} className="rounded border border-white/10 px-3 py-2 text-sm font-bold text-slate-200 hover:bg-white/8">
            1
          </button>
          <span className="px-1 text-slate-500">...</span>
        </>
      )}

      {pages.map((current) => (
        <button
          key={current}
          onClick={() => onPage(current)}
          className={`rounded px-3 py-2 text-sm font-bold ${
            current === page ? 'bg-white text-ink' : 'border border-white/10 text-slate-200 hover:bg-white/8'
          }`}
        >
          {current}
        </button>
      ))}

      {end < totalPages && (
        <>
          <span className="px-1 text-slate-500">...</span>
          <button onClick={() => onPage(totalPages)} className="rounded border border-white/10 px-3 py-2 text-sm font-bold text-slate-200 hover:bg-white/8">
            {totalPages}
          </button>
        </>
      )}

      <button
        onClick={() => onPage(page + 1)}
        disabled={!pagination.hasNext}
        className="inline-flex items-center gap-2 rounded border border-white/10 px-3 py-2 text-sm font-bold text-slate-200 hover:bg-white/8 disabled:opacity-40"
      >
        Proxima
        <ChevronRight size={17} />
      </button>
    </nav>
  );
}
