import PosterCard from './PosterCard.jsx';

export default function ContentRow({ title, items = [] }) {
  if (!items.length) return null;

  return (
    <section className="py-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">{title}</h2>
      </div>
      <div className="no-scrollbar flex gap-3 overflow-x-auto pb-2">
        {items.map((item) => (
          <div key={`${item.type}-${item.id}`} className="w-40 shrink-0 sm:w-44 lg:w-48">
            <PosterCard item={item} />
          </div>
        ))}
      </div>
    </section>
  );
}
