import { CheckCircle2, Eraser, Film, History, LockKeyhole, Mail, MonitorPlay, Save, Settings, ShieldCheck, Star, Tv, Upload, UserCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../api.js';
import EmptyState from '../components/EmptyState.jsx';
import PosterCard from '../components/PosterCard.jsx';
import { useAuth } from '../context/AuthContext.jsx';

function StatBox({ label, value, icon: Icon, tone = 'bg-white/10 text-white' }) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))] p-4 shadow-[0_18px_45px_rgba(0,0,0,0.16)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-slate-400">{label}</p>
          <p className="mt-3 text-3xl font-black text-white">{value ?? 0}</p>
        </div>
        {Icon && (
          <span className={`grid size-11 shrink-0 place-items-center rounded-2xl ${tone}`}>
            <Icon size={20} />
          </span>
        )}
      </div>
    </div>
  );
}

function displayName(user) {
  return user?.displayName || user?.username || 'Usuario';
}

function initials(user) {
  return displayName(user)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function formatWatchedAt(value) {
  if (!value) return '';
  const normalized = String(value).includes('T')
    ? String(value)
    : `${String(value).replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export default function ProfilePage() {
  const { user, updateUser } = useAuth();
  const [profile, setProfile] = useState(null);
  const [stats, setStats] = useState(null);
  const [libraryStats, setLibraryStats] = useState(null);
  const [recent, setRecent] = useState([]);
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState({ displayName: '', email: '', preferHideAdult: true, autoplayNext: true });
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [avatarFile, setAvatarFile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function applyProfileData(data) {
    const nextUser = data.user;
    setProfile(nextUser);
    setStats(data.stats || null);
    setLibraryStats(data.libraryStats || null);
    setRecent(data.recent || []);
    setHistory(data.history || []);
    setForm({
      displayName: nextUser?.displayName || '',
      email: nextUser?.email || '',
      preferHideAdult: nextUser?.preferHideAdult !== false,
      autoplayNext: nextUser?.autoplayNext !== false
    });
    updateUser?.(nextUser);
  }

  function loadProfile() {
    setLoading(true);
    apiFetch('/me/profile', { cacheTtlMs: 15000 })
      .then((data) => {
        applyProfileData(data);
        setError('');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadProfile();
  }, []);

  async function saveProfile(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const data = await apiFetch('/me/profile', {
        method: 'PATCH',
        body: form
      });
      applyProfileData({ ...data, recent, history });
      setMessage('Perfil atualizado');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadAvatar(event) {
    event.preventDefault();
    if (!avatarFile) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const body = new FormData();
      body.append('image', avatarFile);
      const data = await apiFetch('/me/avatar', { method: 'POST', body });
      setProfile(data.user);
      updateUser?.(data.user);
      setAvatarFile(null);
      setMessage('Foto atualizada');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    setMessage('');
    setError('');
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setError('A nova senha e a confirmacao precisam ser iguais');
      return;
    }

    setBusy(true);
    try {
      await apiFetch('/me/password', {
        method: 'PUT',
        body: {
          currentPassword: passwordForm.currentPassword,
          newPassword: passwordForm.newPassword
        }
      });
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setMessage('Senha alterada');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function clearMyProgress() {
    if (!window.confirm('Limpar seus assistidos e continuar assistindo? A biblioteca e favoritos continuam iguais.')) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const data = await apiFetch('/me/progress', { method: 'DELETE' });
      setStats(data.stats || null);
      setRecent([]);
      setHistory([]);
      updateUser?.(data.user);
      setMessage(`${data.removed || 0} registro(s) removido(s)`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function updateRecentFavorite(target, next) {
    setRecent((items) => items.map((item) => (
      item.type === target.type && item.id === target.id ? { ...item, isFavorite: next } : item
    )));
    setHistory((items) => items.map((item) => (
      item.type === target.type && item.id === target.id ? { ...item, isFavorite: next } : item
    )));
  }

  if (loading) return <div className="mx-auto max-w-7xl px-4 py-24 text-slate-300">Carregando perfil...</div>;
  if (error && !profile) return <EmptyState title={error} />;

  const currentUser = profile || user;
  const canViewAdult = Boolean(currentUser?.canViewAdult);

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
      <section className="mb-8 overflow-hidden rounded border border-white/10 bg-white/6">
        <div className="relative min-h-44 bg-[linear-gradient(135deg,#141824,#290b11_48%,#0b3838)]">
          <div className="absolute inset-0 bg-black/20" />
          <div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-end sm:p-7">
            <div className="grid size-28 shrink-0 place-items-center overflow-hidden rounded border border-white/18 bg-black/30 text-3xl font-black text-white shadow-2xl">
              {currentUser?.avatarUrl ? (
                <img src={currentUser.avatarUrl} alt={displayName(currentUser)} className="size-full object-cover" />
              ) : (
                initials(currentUser) || <UserCircle size={42} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="mb-2 inline-flex items-center gap-2 rounded bg-white/12 px-3 py-1 text-xs font-black uppercase text-white">
                {currentUser?.isAdmin ? <ShieldCheck size={14} /> : <UserCircle size={14} />}
                {currentUser?.isAdmin ? 'Administrador' : 'Perfil'}
              </p>
              <h1 className="truncate text-4xl font-black text-white">{displayName(currentUser)}</h1>
              <p className="mt-2 text-sm text-slate-300">@{currentUser?.username}</p>
            </div>
          </div>
        </div>
      </section>

      {(message || error) && (
        <div className={`mb-6 rounded border p-3 text-sm ${error ? 'border-red-500/30 bg-red-950/30 text-red-200' : 'border-white/10 bg-white/6 text-slate-200'}`}>
          {error || message}
        </div>
      )}

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <StatBox label="Historico" value={stats?.progress} icon={History} tone="bg-white text-ink" />
        <StatBox label="Assistidos" value={stats?.watched} icon={CheckCircle2} tone="bg-ocean text-ink" />
        <StatBox label="Favoritos" value={stats?.favorites} icon={Star} tone="bg-amber-300 text-ink" />
      </div>

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <StatBox label="Filmes na biblioteca" value={libraryStats?.movies} icon={Film} tone="bg-brand text-white" />
        <StatBox label="Series na biblioteca" value={libraryStats?.series} icon={MonitorPlay} tone="bg-white/14 text-white" />
        <StatBox label="Canais na biblioteca" value={libraryStats?.channels} icon={Tv} tone="bg-emerald-300 text-ink" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[0.95fr,1.05fr]">
        <div className="space-y-6">
          <form onSubmit={saveProfile} className="rounded border border-white/10 bg-white/6 p-5">
            <div className="mb-5 flex items-center gap-3">
              <div className="grid size-11 place-items-center rounded bg-white text-ink">
                <Settings size={21} />
              </div>
              <div>
                <h2 className="text-xl font-black text-white">Dados do perfil</h2>
                <p className="text-sm text-slate-400">Nome publico, email e preferencias.</p>
              </div>
            </div>

            <label className="block">
              <span className="text-sm font-bold text-slate-200">Nome de exibicao</span>
              <input
                value={form.displayName}
                onChange={(event) => setForm((value) => ({ ...value, displayName: event.target.value }))}
                className="mt-2 w-full rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none placeholder:text-slate-500"
                placeholder={currentUser?.username}
              />
            </label>

            <label className="mt-4 block">
              <span className="text-sm font-bold text-slate-200">Email</span>
              <div className="mt-2 flex items-center gap-2 rounded border border-white/10 bg-black/24 px-3 py-3">
                <Mail size={17} className="text-muted" />
                <input
                  value={form.email}
                  onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))}
                  className="w-full bg-transparent text-white outline-none placeholder:text-slate-500"
                  placeholder="email@exemplo.com"
                />
              </div>
            </label>

            <label className="mt-4 flex items-center gap-3 rounded border border-white/10 bg-black/18 px-3 py-3 text-sm text-slate-200">
              <input
                checked={form.autoplayNext}
                onChange={(event) => setForm((value) => ({ ...value, autoplayNext: event.target.checked }))}
                type="checkbox"
                className="size-4 accent-brand"
              />
              Pular para o proximo episodio automaticamente
            </label>

            {canViewAdult && (
              <label className="mt-3 flex items-center gap-3 rounded border border-white/10 bg-black/18 px-3 py-3 text-sm text-slate-200">
                <input
                  checked={form.preferHideAdult}
                  onChange={(event) => setForm((value) => ({ ...value, preferHideAdult: event.target.checked }))}
                  type="checkbox"
                  className="size-4 accent-brand"
                />
                Ocultar +18 por padrao
              </label>
            )}

            <button disabled={busy} className="mt-5 inline-flex items-center gap-2 rounded bg-white px-5 py-3 text-sm font-black text-ink hover:bg-slate-200 disabled:opacity-60">
              <Save size={17} />
              Salvar perfil
            </button>
          </form>

          <form onSubmit={uploadAvatar} className="rounded border border-white/10 bg-white/6 p-5">
            <div className="mb-5 flex items-center gap-3">
              <div className="grid size-11 place-items-center rounded bg-ocean text-ink">
                <Upload size={21} />
              </div>
              <div>
                <h2 className="text-xl font-black text-white">Foto</h2>
                <p className="text-sm text-slate-400">Use uma imagem quadrada para ficar mais bonita.</p>
              </div>
            </div>
            <label className="flex items-center gap-3 rounded border border-dashed border-white/18 bg-black/18 p-3 text-sm text-slate-200">
              <UserCircle size={18} />
              <span className="min-w-0 flex-1 truncate">{avatarFile?.name || 'Carregar foto do computador'}</span>
              <input type="file" accept="image/*" onChange={(event) => setAvatarFile(event.target.files?.[0] || null)} className="hidden" />
            </label>
            <button disabled={busy || !avatarFile} className="mt-4 inline-flex items-center gap-2 rounded bg-white px-5 py-3 text-sm font-black text-ink hover:bg-slate-200 disabled:opacity-60">
              <Upload size={17} />
              Atualizar foto
            </button>
          </form>
        </div>

        <div className="space-y-6">
          <form onSubmit={changePassword} className="rounded border border-white/10 bg-white/6 p-5">
            <div className="mb-5 flex items-center gap-3">
              <div className="grid size-11 place-items-center rounded bg-brand text-white">
                <LockKeyhole size={21} />
              </div>
              <div>
                <h2 className="text-xl font-black text-white">Senha</h2>
                <p className="text-sm text-slate-400">Troque a senha da sua conta.</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <input
                value={passwordForm.currentPassword}
                onChange={(event) => setPasswordForm((value) => ({ ...value, currentPassword: event.target.value }))}
                type="password"
                className="rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none placeholder:text-slate-500"
                placeholder="Senha atual"
              />
              <input
                value={passwordForm.newPassword}
                onChange={(event) => setPasswordForm((value) => ({ ...value, newPassword: event.target.value }))}
                type="password"
                className="rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none placeholder:text-slate-500"
                placeholder="Nova senha"
              />
              <input
                value={passwordForm.confirmPassword}
                onChange={(event) => setPasswordForm((value) => ({ ...value, confirmPassword: event.target.value }))}
                type="password"
                className="rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none placeholder:text-slate-500"
                placeholder="Confirmar"
              />
            </div>
            <button disabled={busy || !passwordForm.currentPassword || passwordForm.newPassword.length < 6} className="mt-4 inline-flex items-center gap-2 rounded bg-white px-5 py-3 text-sm font-black text-ink hover:bg-slate-200 disabled:opacity-60">
              <LockKeyhole size={17} />
              Alterar senha
            </button>
          </form>

          <section className="rounded border border-white/10 bg-white/6 p-5">
            <div className="mb-5 flex items-center gap-3">
              <div className="grid size-11 place-items-center rounded bg-white text-ink">
                <History size={21} />
              </div>
              <div>
                <h2 className="text-xl font-black text-white">Controle</h2>
                <p className="text-sm text-slate-400">Limpe o historico sem apagar biblioteca ou favoritos.</p>
              </div>
            </div>
            <button onClick={clearMyProgress} disabled={busy || !stats?.progress} className="inline-flex items-center gap-2 rounded border border-white/10 px-5 py-3 text-sm font-bold text-slate-200 hover:bg-white/8 disabled:opacity-60">
              <Eraser size={17} />
              Limpar meus assistidos
            </button>
          </section>
        </div>
      </div>

      <section className="mt-10">
        <div className="mb-4 flex items-center gap-3">
          <History size={22} className="text-slate-300" />
          <h2 className="text-2xl font-black text-white">Continue de onde parou</h2>
        </div>
        {recent.length ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {recent.map((item) => (
              <PosterCard key={`${item.type}-${item.id}`} item={item} onFavoriteChange={updateRecentFavorite} />
            ))}
          </div>
        ) : (
          <div className="rounded border border-white/10 bg-white/6 p-6 text-sm text-slate-400">
            Nada em andamento para retomar agora.
          </div>
        )}
      </section>

      <section className="mt-10">
        <div className="mb-4 flex items-center gap-3">
          <History size={22} className="text-slate-300" />
          <h2 className="text-2xl font-black text-white">Historico assistido</h2>
        </div>
        {history.length ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {history.map((item) => (
              <div key={`${item.type}-${item.id}-${item.watchedAt || item.progress?.completed_at || item.progress?.updated_at || 'history'}`}>
                <PosterCard item={item} onFavoriteChange={updateRecentFavorite} />
                <p className="mt-2 px-1 text-xs font-semibold text-slate-400">
                  {item.type === 'episode' && item.seriesTitle ? `${item.seriesTitle} - ` : ''}
                  {item.watchedAt ? `Assistido em ${formatWatchedAt(item.watchedAt)}` : 'Assistido'}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded border border-white/10 bg-white/6 p-6 text-sm text-slate-400">
            Nenhum item concluido ainda neste perfil.
          </div>
        )}
      </section>
    </div>
  );
}
