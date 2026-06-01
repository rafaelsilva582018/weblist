import { AlertTriangle, Film, Home, LogOut, MonitorPlay, Search, Settings, Star, Tv, UserCircle } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const baseNavItems = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/filmes', label: 'Filmes', icon: Film },
  { to: '/series', label: 'Series', icon: MonitorPlay },
  { to: '/canais', label: 'Canais', icon: Tv },
  { to: '/favoritos', label: 'Favoritos', icon: Star }
];

const adminNavItems = [
  { to: '/problemas', label: 'Problemas', icon: AlertTriangle }
];

export default function Layout() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') || '');
  const { user, logout } = useAuth();
  const navItems = user?.isAdmin ? [...baseNavItems, ...adminNavItems] : baseNavItems;

  function submitSearch(event) {
    event.preventDefault();
    const value = query.trim();
    if (value) navigate(`/search?q=${encodeURIComponent(value)}`);
  }

  return (
    <div className="min-h-screen">
      <header className="fixed inset-x-0 top-0 z-40 border-b border-white/10 bg-ink/86 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
          <NavLink to="/" className="flex items-center gap-2 text-xl font-black tracking-normal text-white">
            <span className="grid size-9 place-items-center rounded bg-brand text-sm shadow-glow">W</span>
            <span>Weblist</span>
          </NavLink>

          <nav className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex items-center gap-2 rounded px-3 py-2 text-sm transition ${
                      isActive ? 'bg-white/10 text-white' : 'text-slate-300 hover:bg-white/8 hover:text-white'
                    }`
                  }
                >
                  <Icon size={17} />
                  {item.label}
                </NavLink>
              );
            })}
          </nav>

          <form onSubmit={submitSearch} className="ml-auto hidden w-full max-w-sm items-center gap-2 rounded border border-white/10 bg-white/6 px-3 py-2 sm:flex">
            <Search size={17} className="text-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-500"
              placeholder="Buscar titulo ou ator"
            />
          </form>

          <div className="hidden items-center gap-2 sm:flex">
            <div className="hidden items-center gap-2 rounded border border-white/10 bg-white/6 px-3 py-2 text-sm text-slate-200 lg:flex">
              <UserCircle size={17} className="text-slate-400" />
              <span className="max-w-28 truncate">{user?.username}</span>
            </div>
            <button
              type="button"
              onClick={logout}
              className="grid size-10 place-items-center rounded border border-white/10 bg-white/6 text-slate-300 transition hover:bg-white/10 hover:text-white"
              title="Sair"
            >
              <LogOut size={18} />
            </button>
          </div>

          {user?.isAdmin && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `grid size-10 place-items-center rounded border border-white/10 transition ${
                  isActive ? 'bg-brand text-white' : 'bg-white/6 text-slate-300 hover:bg-white/10 hover:text-white'
                }`
              }
              title="Admin"
            >
              <Settings size={18} />
            </NavLink>
          )}
        </div>

        <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-3 sm:hidden">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex shrink-0 items-center gap-2 rounded px-3 py-2 text-sm ${
                    isActive ? 'bg-white/12 text-white' : 'text-slate-300'
                  }`
                }
              >
                <Icon size={16} />
                {item.label}
              </NavLink>
            );
          })}
          {user?.isAdmin && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `flex shrink-0 items-center gap-2 rounded px-3 py-2 text-sm ${
                  isActive ? 'bg-white/12 text-white' : 'text-slate-300'
                }`
              }
            >
              <Settings size={16} />
              Admin
            </NavLink>
          )}
          <button type="button" onClick={logout} className="flex shrink-0 items-center gap-2 rounded px-3 py-2 text-sm text-slate-300">
            <LogOut size={16} />
            Sair
          </button>
        </div>
      </header>

      <main className="pt-20 sm:pt-24">
        <Outlet />
      </main>
    </div>
  );
}
