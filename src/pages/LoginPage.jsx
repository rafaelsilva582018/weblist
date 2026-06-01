import { Eye, EyeOff, LockKeyhole, Play, User } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

const tiles = [
  ['#e50914', '#7f1d1d'],
  ['#2dd4bf', '#0f766e'],
  ['#f5c451', '#854d0e'],
  ['#94a3b8', '#1e293b'],
  ['#f43f5e', '#881337'],
  ['#38bdf8', '#075985'],
  ['#a3e635', '#3f6212'],
  ['#fb7185', '#9f1239'],
  ['#f97316', '#7c2d12'],
  ['#22c55e', '#14532d'],
  ['#c084fc', '#581c87'],
  ['#f8fafc', '#334155']
];

export default function LoginPage() {
  const { login } = useAuth();
  const [backgroundItems, setBackgroundItems] = useState([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mosaicItems = useMemo(() => {
    if (!backgroundItems.length) return [];
    return Array.from({ length: 56 }, (_, index) => backgroundItems[index % backgroundItems.length]);
  }, [backgroundItems]);

  useEffect(() => {
    let active = true;
    apiFetch('/auth/login-background')
      .then((data) => {
        if (!active) return;
        setBackgroundItems(
          (data.items || []).filter((item) => item.imageUrl && ['movie', 'series'].includes(item.type))
        );
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login({ username, password });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-ink text-white">
      <div className="absolute inset-0 opacity-46">
        <div className="login-mosaic grid min-h-[125vh] min-w-[1120px] grid-cols-8 gap-1.5 p-4 sm:grid-cols-11">
          {mosaicItems.length > 0 ? mosaicItems.map((item, index) => (
            <div
              key={`${item.type}-${item.id}-${index}`}
              className="login-mosaic-tile flex aspect-[2/3] items-center justify-center overflow-hidden rounded-sm border border-white/10 bg-black/70 shadow-xl"
              style={{ marginTop: `${(index % 5) * 6}px` }}
            >
              <img
                src={item.imageUrl}
                alt=""
                className="size-full object-contain"
                loading="lazy"
                onError={(event) => {
                  event.currentTarget.style.opacity = '0';
                }}
              />
            </div>
          )) : Array.from({ length: 48 }).map((_, index) => {
            const [from, to] = tiles[index % tiles.length];
            return (
              <div
                key={index}
                className="aspect-[2/3] rounded-sm border border-white/10 shadow-xl"
                style={{
                  background: `linear-gradient(145deg, ${from}, ${to})`,
                  marginTop: `${(index % 5) * 6}px`
                }}
              />
            );
          })}
        </div>
      </div>

      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(229,9,20,0.34),transparent_28rem),linear-gradient(90deg,rgba(8,9,13,0.98),rgba(8,9,13,0.72),rgba(8,9,13,0.98))]" />

      <main className="relative z-10 flex min-h-screen items-center justify-center px-4 py-10">
        <section className="w-full max-w-md rounded border border-white/10 bg-black/72 p-6 shadow-2xl backdrop-blur-xl sm:p-8">
          <div className="mb-8 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="grid size-11 place-items-center rounded bg-brand text-lg font-black shadow-glow">W</span>
              <div>
                <h1 className="text-2xl font-black tracking-normal">Weblist</h1>
                <p className="text-sm text-slate-400">Sua biblioteca</p>
              </div>
            </div>
            <span className="grid size-10 place-items-center rounded-full border border-white/10 bg-white/8">
              <Play size={18} fill="currentColor" />
            </span>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-bold text-slate-200">Usuario</span>
              <span className="flex items-center gap-3 rounded border border-white/10 bg-white/8 px-3 py-3 focus-within:border-white/28">
                <User size={18} className="text-slate-400" />
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  className="w-full bg-transparent text-white outline-none placeholder:text-slate-500"
                  placeholder="Digite seu usuario"
                />
              </span>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-bold text-slate-200">Senha</span>
              <span className="flex items-center gap-3 rounded border border-white/10 bg-white/8 px-3 py-3 focus-within:border-white/28">
                <LockKeyhole size={18} className="text-slate-400" />
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  className="w-full bg-transparent text-white outline-none placeholder:text-slate-500"
                  placeholder="Digite sua senha"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  className="grid size-8 place-items-center rounded text-slate-300 hover:bg-white/10 hover:text-white"
                  title={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </span>
            </label>

            {error && <p className="rounded border border-red-400/20 bg-red-950/30 px-3 py-2 text-sm text-red-200">{error}</p>}

            <button
              disabled={busy || !username.trim() || !password}
              className="w-full rounded bg-brand px-5 py-3 text-sm font-black text-white shadow-glow transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? 'Entrando...' : 'Entrar'}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
