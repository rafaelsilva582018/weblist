import { Link } from 'react-router-dom';

export default function EmptyState({ title = 'Nada encontrado', action }) {
  return (
    <div className="mx-auto max-w-xl py-20 text-center">
      <div className="mx-auto mb-5 grid size-16 place-items-center rounded bg-white/8 text-2xl font-black text-white">W</div>
      <h2 className="text-2xl font-bold text-white">{title}</h2>
      {action && (
        <Link to={action.to} className="mt-6 inline-flex rounded bg-brand px-5 py-3 text-sm font-bold text-white hover:bg-red-600">
          {action.label}
        </Link>
      )}
    </div>
  );
}
