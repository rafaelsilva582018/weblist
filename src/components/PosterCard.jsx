import { Play, Tv } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { mediaLink, progressPercent } from '../api.js';

function initials(title = '') {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export default function PosterCard({ item }) {
  const [imageOk, setImageOk] = useState(Boolean(item?.posterUrl));
  const title = item?.displayTitle || item?.title || item?.seriesTitle || 'Sem titulo';
  const isChannel = item?.type === 'channel';
  const subtitle = isChannel && item?.currentProgram?.title ? `Agora: ${item.currentProgram.title}` : item?.category;
  const percent = progressPercent(item?.progress);

  return (
    <Link
      to={mediaLink(item)}
      className={`card-focus group relative block min-w-40 overflow-hidden rounded border border-white/10 bg-panel ${
        isChannel ? 'aspect-[16/10]' : 'aspect-[2/3]'
      }`}
    >
      {imageOk ? (
        <img
          src={item.posterUrl}
          alt={title}
          className="absolute inset-0 size-full object-cover"
          loading="lazy"
          onError={() => setImageOk(false)}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-[linear-gradient(145deg,#191d28,#2b1114_55%,#102a2b)] px-4 text-center">
          <div>
            <div className="mx-auto mb-3 grid size-14 place-items-center rounded bg-white/10 text-lg font-black text-white">
              {isChannel ? <Tv size={24} /> : initials(title)}
            </div>
            <p className="line-clamp-3 text-sm font-semibold text-white/88">{title}</p>
          </div>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/68 to-transparent p-3 pt-16">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-semibold text-white">{title}</p>
            {subtitle && <p className="mt-1 truncate text-xs text-slate-300">{subtitle}</p>}
          </div>
          <span className="grid size-9 shrink-0 translate-y-1 place-items-center rounded-full bg-white text-ink opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100">
            <Play size={16} fill="currentColor" />
          </span>
        </div>
        {percent > 0 && (
          <div className="mt-3 h-1 overflow-hidden rounded bg-white/20">
            <div className="h-full rounded bg-brand" style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
    </Link>
  );
}
