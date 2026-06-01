import { CalendarDays, Database, Eraser, FileUp, Image, KeyRound, RefreshCcw, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../api.js';
import { useAuth } from '../context/AuthContext.jsx';

function StatBox({ label, value }) {
  return (
    <div className="rounded border border-white/10 bg-white/6 p-4">
      <p className="text-sm text-slate-400">{label}</p>
      <p className="mt-2 text-3xl font-black text-white">{value}</p>
    </div>
  );
}

export default function AdminPage() {
  const { logout: authLogout, token, user } = useAuth();
  const [file, setFile] = useState(null);
  const [content, setContent] = useState('');
  const [job, setJob] = useState(null);
  const [enrichJob, setEnrichJob] = useState(null);
  const [stats, setStats] = useState(null);
  const [tmdbStatus, setTmdbStatus] = useState(null);
  const [omdbStatus, setOmdbStatus] = useState(null);
  const [tmdbApiKey, setTmdbApiKey] = useState('');
  const [tmdbAccessToken, setTmdbAccessToken] = useState('');
  const [omdbApiKey, setOmdbApiKey] = useState('');
  const [tmdbLanguage, setTmdbLanguage] = useState('pt-BR');
  const [tmdbLimit, setTmdbLimit] = useState(1000);
  const [tmdbMode, setTmdbMode] = useState('missing');
  const [tmdbRunAll, setTmdbRunAll] = useState(true);
  const [epgStatus, setEpgStatus] = useState(null);
  const [epgUrl, setEpgUrl] = useState('');
  const [epgContent, setEpgContent] = useState('');
  const [epgJob, setEpgJob] = useState(null);
  const [epgJobSource, setEpgJobSource] = useState('xmltv');
  const [error, setError] = useState('');
  const [libraryMessage, setLibraryMessage] = useState('');
  const [tmdbMessage, setTmdbMessage] = useState('');
  const [epgMessage, setEpgMessage] = useState('');
  const [users, setUsers] = useState([]);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [newCanViewAdult, setNewCanViewAdult] = useState(false);
  const [userMessage, setUserMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const percent = useMemo(() => {
    if (!job?.totalBytes) return 0;
    return Math.min(100, Math.round((job.bytesRead / job.totalBytes) * 100));
  }, [job]);

  const epgPercent = useMemo(() => {
    if (!epgJob?.totalPrograms) return 0;
    return Math.min(100, Math.round((epgJob.processed / epgJob.totalPrograms) * 100));
  }, [epgJob]);

  useEffect(() => {
    if (!token) return;
    apiFetch('/admin/settings')
      .then((data) => {
        setTmdbStatus(data.tmdb);
        setOmdbStatus(data.omdb);
        setEpgStatus(data.epg);
        setEpgUrl(data.epg?.url || '');
        setTmdbLanguage(data.raw?.tmdbLanguage || data.tmdb?.language || 'pt-BR');
      })
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;

    let cancelled = false;
    const loadActiveJob = () => {
      apiFetch('/tmdb/enrich/active')
        .then((data) => {
          if (!cancelled && data.job) setEnrichJob(data.job);
        })
        .catch(() => {});
    };

    loadActiveJob();
    const timer = setInterval(() => {
      if (!enrichJob || ['done', 'error', 'stopped'].includes(enrichJob.status)) {
        loadActiveJob();
      }
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enrichJob, token]);

  useEffect(() => {
    if (!enrichJob || !['queued', 'running', 'paused'].includes(enrichJob.status)) return undefined;
    const timer = setInterval(() => {
      apiFetch(`/tmdb/enrich/${enrichJob.id}`)
        .then((data) => {
          setEnrichJob(data.job);
          if (['done', 'error', 'stopped'].includes(data.job.status)) refreshStats();
        })
        .catch((err) => setTmdbMessage(err.message));
    }, enrichJob.status === 'paused' ? 5000 : 1200);
    return () => clearInterval(timer);
  }, [enrichJob]);

  useEffect(() => {
    if (!epgJob || !['queued', 'running'].includes(epgJob.status)) return undefined;
    const endpoint = epgJobSource === 'iptv-org' ? `/epg/iptv-org/${epgJob.id}` : `/epg/import/${epgJob.id}`;
    const timer = setInterval(() => {
      apiFetch(endpoint)
        .then((data) => {
          setEpgJob(data.job);
          if (['done', 'error'].includes(data.job.status)) refreshEpgStatus();
        })
        .catch((err) => setEpgMessage(err.message));
    }, 1200);
    return () => clearInterval(timer);
  }, [epgJob, epgJobSource]);

  function refreshStats() {
    apiFetch('/stats').then(setStats).catch(() => {});
  }

  function refreshEpgStatus() {
    apiFetch('/epg/status')
      .then((data) => {
        setEpgStatus(data.epg);
        if (data.epg?.url) setEpgUrl(data.epg.url);
      })
      .catch(() => {});
  }

  function refreshUsers() {
    apiFetch('/admin/users')
      .then((data) => setUsers(data.users || []))
      .catch((err) => setUserMessage(err.message));
  }

  useEffect(() => {
    refreshStats();
  }, []);

  useEffect(() => {
    if (!token) return;
    refreshUsers();
  }, [token]);

  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return undefined;
    const timer = setInterval(() => {
      apiFetch(`/import/${job.id}`)
        .then((data) => {
          setJob(data.job);
          if (['done', 'error'].includes(data.job.status)) refreshStats();
        })
        .catch((err) => setError(err.message));
    }, 900);
    return () => clearInterval(timer);
  }, [job]);

  async function startImport(event) {
    event.preventDefault();
    if (!file && !content.trim()) {
      setError('Envie um arquivo ou cole o conteudo M3U');
      return;
    }

    setBusy(true);
    setError('');
    setLibraryMessage('');
    try {
      const form = new FormData();
      if (file) form.append('file', file);
      if (content.trim()) form.append('content', content);
      const data = await apiFetch('/import', { method: 'POST', body: form });
      setJob(data.job);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (!window.confirm('Limpar toda a biblioteca importada?')) return;
    setBusy(true);
    setError('');
    setLibraryMessage('');
    try {
      const data = await apiFetch('/library', { method: 'DELETE' });
      setStats(data.stats);
      setJob(null);
      setLibraryMessage('Biblioteca limpa');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function clearUserProgress(userId, username = 'usuario') {
    if (!userId) return;
    if (!window.confirm(`Limpar assistidos e continuar assistindo de ${username}? A biblioteca continua igual.`)) return;
    setBusy(true);
    setError('');
    setLibraryMessage('');
    setUserMessage('');
    try {
      const data = await apiFetch(`/admin/users/${userId}/progress`, { method: 'DELETE' });
      setStats(data.stats);
      setUsers(data.users || []);
      const message = `${data.removed || 0} registro(s) de historico removido(s) de ${username}`;
      setLibraryMessage(message);
      setUserMessage(message);
    } catch (err) {
      setError(err.message);
      setUserMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function clearWatched() {
    await clearUserProgress(user?.id, user?.username || 'usuario atual');
  }

  async function createUser(event) {
    event.preventDefault();
    setBusy(true);
    setUserMessage('');
    try {
      const data = await apiFetch('/admin/users', {
        method: 'POST',
        body: {
          username: newUsername,
          password: newPassword,
          isAdmin: newIsAdmin,
          canViewAdult: newCanViewAdult
        }
      });
      setUsers(data.users || []);
      setNewUsername('');
      setNewPassword('');
      setNewIsAdmin(false);
      setNewCanViewAdult(false);
      setUserMessage('Usuario criado');
    } catch (err) {
      setUserMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeUser(userId) {
    if (!window.confirm('Remover este usuario?')) return;
    setBusy(true);
    setUserMessage('');
    try {
      const data = await apiFetch(`/admin/users/${userId}`, { method: 'DELETE' });
      setUsers(data.users || []);
      setUserMessage('Usuario removido');
    } catch (err) {
      setUserMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveTmdbSettings(event) {
    event.preventDefault();
    setBusy(true);
    setTmdbMessage('');
    try {
      const data = await apiFetch('/admin/settings', {
        method: 'PUT',
        body: {
          tmdbApiKey,
          tmdbAccessToken,
          omdbApiKey,
          tmdbLanguage
        }
      });
      setTmdbStatus(data.tmdb);
      setOmdbStatus(data.omdb);
      setTmdbApiKey('');
      setTmdbAccessToken('');
      setOmdbApiKey('');
      setTmdbMessage('TMDB configurado');
    } catch (err) {
      setTmdbMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function startTmdbEnrichment() {
    setBusy(true);
    setTmdbMessage('');
    try {
      const data = await apiFetch('/tmdb/enrich', {
        method: 'POST',
          body: {
            limit: Number(tmdbLimit) || 1000,
            runAll: tmdbRunAll,
            force: tmdbMode === 'replace'
          }
      });
      setEnrichJob(data.job);
    } catch (err) {
      setTmdbMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function startEpgImport(event) {
    event.preventDefault();
    if (!epgUrl.trim() && !epgContent.trim()) {
      setEpgMessage('Cole a URL XMLTV ou o conteudo XML');
      return;
    }

    setBusy(true);
    setEpgMessage('');
    try {
      const data = await apiFetch('/epg/import', {
        method: 'POST',
        body: {
          url: epgUrl.trim(),
          content: epgContent.trim()
        }
      });
      setEpgJobSource('xmltv');
      setEpgJob(data.job);
      if (epgUrl.trim()) setEpgContent('');
    } catch (err) {
      setEpgMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function startIptvOrgEpg() {
    setBusy(true);
    setEpgMessage('');
    try {
      const data = await apiFetch('/epg/iptv-org', { method: 'POST' });
      setEpgJobSource('iptv-org');
      setEpgJob(data.job);
    } catch (err) {
      setEpgMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    authLogout();
  }

  async function controlTmdbJob(action) {
    if (!enrichJob?.id) return;
    setTmdbMessage('');
    try {
      const data = await apiFetch(`/tmdb/enrich/${enrichJob.id}`, {
        method: 'PATCH',
        body: { action }
      });
      setEnrichJob(data.job);
    } catch (err) {
      setTmdbMessage(err.message);
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6 lg:px-8">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-4xl font-black text-white">Admin</h1>
          <p className="mt-2 text-sm text-slate-400">Importe playlists M3U/M3U8 para a biblioteca local.</p>
        </div>
        <button onClick={logout} className="rounded border border-white/10 px-4 py-2 text-sm font-bold text-slate-200 hover:bg-white/8">
          Sair
        </button>
      </div>

      <div className="mb-8 grid gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <StatBox label="Filmes" value={stats?.movies ?? 0} />
        <StatBox label="Series" value={stats?.series ?? 0} />
        <StatBox label="Temporadas" value={stats?.seasons ?? 0} />
        <StatBox label="Episodios" value={stats?.episodes ?? 0} />
        <StatBox label="Canais" value={stats?.channels ?? 0} />
        <StatBox label="Assistidos" value={stats?.watched ?? 0} />
        <StatBox label="Fontes" value={stats?.sources ?? 0} />
        <StatBox label="Categorias" value={stats?.categories ?? 0} />
      </div>

      <section className="mb-6 grid gap-6 lg:grid-cols-[1.1fr,0.9fr]">
        <form onSubmit={createUser} className="rounded border border-white/10 bg-white/6 p-5">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded bg-ocean text-ink">
              <UserPlus size={21} />
            </div>
            <div>
              <h2 className="text-xl font-black text-white">Usuarios</h2>
              <p className="text-sm text-slate-400">Cadastre quem pode entrar na tela inicial.</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-bold text-slate-200">Usuario</span>
              <input
                value={newUsername}
                onChange={(event) => setNewUsername(event.target.value)}
                className="mt-2 w-full rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none placeholder:text-slate-500"
                placeholder="nome de acesso"
              />
            </label>
            <label className="block">
              <span className="text-sm font-bold text-slate-200">Senha</span>
              <input
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                type="password"
                className="mt-2 w-full rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none placeholder:text-slate-500"
                placeholder="minimo 6 caracteres"
              />
            </label>
          </div>

          <label className="mt-4 flex items-center gap-3 rounded border border-white/10 bg-black/18 px-3 py-3 text-sm text-slate-200">
            <input checked={newIsAdmin} onChange={(event) => setNewIsAdmin(event.target.checked)} type="checkbox" className="size-4 accent-brand" />
            Dar acesso de administrador
          </label>

          <label className="mt-3 flex items-center gap-3 rounded border border-white/10 bg-black/18 px-3 py-3 text-sm text-slate-200">
            <input checked={newCanViewAdult} onChange={(event) => setNewCanViewAdult(event.target.checked)} type="checkbox" className="size-4 accent-brand" />
            Permitir conteudo +18
          </label>

          {userMessage && <p className="mt-4 text-sm text-slate-300">{userMessage}</p>}

          <button disabled={busy || !newUsername.trim() || newPassword.length < 6} className="mt-5 inline-flex items-center gap-2 rounded bg-white px-5 py-3 text-sm font-black text-ink hover:bg-slate-200 disabled:opacity-60">
            <UserPlus size={17} />
            Criar usuario
          </button>
        </form>

        <aside className="rounded border border-white/10 bg-white/6 p-5">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded bg-white text-ink">
              <Users size={21} />
            </div>
            <div>
              <h2 className="text-xl font-black text-white">Acessos</h2>
              <p className="text-sm text-slate-400">{users.length} usuario(s) cadastrado(s)</p>
            </div>
          </div>

          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {users.map((item) => (
              <div key={item.id} className="flex items-center gap-3 rounded border border-white/10 bg-black/20 px-3 py-3">
                <div className="grid size-10 place-items-center rounded bg-white/8 text-slate-200">
                  {item.isAdmin ? <ShieldCheck size={18} /> : <Users size={18} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold text-white">{item.username}</p>
                  <p className="text-xs text-slate-400">
                    {item.isAdmin ? 'Administrador' : 'Usuario'} - {item.canViewAdult ? '+18 permitido' : '+18 bloqueado'}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {item.watchedCount || 0} assistido(s) - {item.progressCount || 0} historico(s)
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => clearUserProgress(item.id, item.username)}
                  disabled={busy || !item.progressCount}
                  className="grid size-9 place-items-center rounded border border-white/10 text-slate-300 hover:bg-white/8 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  title="Limpar assistidos e progresso"
                >
                  <Eraser size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => removeUser(item.id)}
                  disabled={busy || item.id === user?.id}
                  className="grid size-9 place-items-center rounded border border-white/10 text-slate-300 hover:bg-white/8 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  title={item.id === user?.id ? 'Usuario atual' : 'Remover'}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </aside>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
        <form onSubmit={startImport} className="rounded border border-white/10 bg-white/6 p-5">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded bg-brand text-white">
              <FileUp size={21} />
            </div>
            <div>
              <h2 className="text-xl font-black text-white">Importacao</h2>
              <p className="text-sm text-slate-400">Arquivo .m3u, .m3u8 ou conteudo colado.</p>
            </div>
          </div>

          <label className="block rounded border border-dashed border-white/18 bg-black/18 p-4">
            <span className="text-sm font-bold text-slate-200">Arquivo</span>
            <input
              type="file"
              accept=".m3u,.m3u8,.txt"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
              className="mt-3 block w-full text-sm text-slate-300 file:mr-4 file:rounded file:border-0 file:bg-white file:px-4 file:py-2 file:text-sm file:font-bold file:text-ink"
            />
          </label>

          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="mt-4 min-h-48 w-full rounded border border-white/10 bg-black/24 p-3 text-sm text-white outline-none placeholder:text-slate-500"
            placeholder="#EXTM3U"
          />

          {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
          {libraryMessage && <p className="mt-4 text-sm text-slate-300">{libraryMessage}</p>}

          <div className="mt-5 flex flex-wrap gap-3">
            <button disabled={busy || job?.status === 'running'} className="inline-flex items-center gap-2 rounded bg-brand px-5 py-3 text-sm font-black text-white hover:bg-red-600 disabled:opacity-60">
              <RefreshCcw size={17} />
              Importar
            </button>
            <button type="button" onClick={clearAll} disabled={busy} className="inline-flex items-center gap-2 rounded border border-white/10 px-5 py-3 text-sm font-bold text-slate-200 hover:bg-white/8 disabled:opacity-60">
              <Trash2 size={17} />
              Limpar biblioteca
            </button>
            <button type="button" onClick={clearWatched} disabled={busy || !user?.id} className="inline-flex items-center gap-2 rounded border border-white/10 px-5 py-3 text-sm font-bold text-slate-200 hover:bg-white/8 disabled:opacity-60">
              <Eraser size={17} />
              Limpar meus assistidos
            </button>
          </div>
        </form>

        <aside className="rounded border border-white/10 bg-white/6 p-5">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded bg-ocean text-ink">
              <Database size={21} />
            </div>
            <div>
              <h2 className="text-xl font-black text-white">Status</h2>
              <p className="text-sm text-slate-400">{job?.message || 'Sem importacao ativa'}</p>
            </div>
          </div>

          {job ? (
            <div className="space-y-4">
              <div>
                <div className="mb-2 flex justify-between text-sm text-slate-300">
                  <span>{job.status}</span>
                  <span>{percent}%</span>
                </div>
                <div className="h-3 overflow-hidden rounded bg-black/40">
                  <div className={`h-full rounded bg-brand ${job.status === 'running' ? 'transition-all' : ''}`} style={{ width: `${percent || (job.status === 'running' ? 12 : 0)}%` }} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <StatBox label="Linhas" value={job.processedLines} />
                <StatBox label="Itens" value={job.processedItems} />
                <StatBox label="Duplicados" value={job.duplicates} />
                <StatBox label="Erros" value={job.errors} />
              </div>

              <div className="rounded bg-black/24 p-3 text-sm text-slate-300">
                <p>Filmes: {job.imported.movies}</p>
                <p>Series: {job.imported.series}</p>
                <p>Temporadas: {job.imported.seasons}</p>
                <p>Episodios: {job.imported.episodes}</p>
                <p>Canais: {job.imported.channels}</p>
                <p>Opcoes de link: {job.imported.sources || 0}</p>
              </div>

              {job.errorSamples?.length > 0 && (
                <div className="rounded bg-red-950/30 p-3 text-xs text-red-200">
                  {job.errorSamples.map((sample) => (
                    <p key={sample} className="truncate">{sample}</p>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-400">O progresso aparece aqui depois que a importacao comecar.</p>
          )}
        </aside>
      </div>

      <section className="mt-6 grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
        <form onSubmit={startEpgImport} className="rounded border border-white/10 bg-white/6 p-5">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded bg-ocean text-ink">
              <CalendarDays size={21} />
            </div>
            <div>
              <h2 className="text-xl font-black text-white">EPG</h2>
              <p className="text-sm text-slate-400">Grade XMLTV dos canais ao vivo.</p>
            </div>
          </div>

          <label className="block">
            <span className="text-sm font-bold text-slate-200">URL XMLTV</span>
            <input
              value={epgUrl}
              onChange={(event) => setEpgUrl(event.target.value)}
              className="mt-2 w-full rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none placeholder:text-slate-500"
              placeholder="https://.../xmltv.php ou https://.../epg.xml.gz"
            />
          </label>

          <textarea
            value={epgContent}
            onChange={(event) => setEpgContent(event.target.value)}
            className="mt-4 min-h-32 w-full rounded border border-white/10 bg-black/24 p-3 text-sm text-white outline-none placeholder:text-slate-500"
            placeholder="<tv>...</tv>"
          />

          {epgMessage && <p className="mt-4 text-sm text-slate-300">{epgMessage}</p>}

          <div className="mt-5 flex flex-wrap gap-3">
            <button disabled={busy || epgJob?.status === 'running'} className="inline-flex items-center gap-2 rounded bg-white px-5 py-3 text-sm font-black text-ink hover:bg-slate-200 disabled:opacity-60">
              <CalendarDays size={17} />
              Importar EPG
            </button>
            <button type="button" onClick={refreshEpgStatus} className="inline-flex items-center gap-2 rounded border border-white/10 px-5 py-3 text-sm font-bold text-slate-200 hover:bg-white/8">
              <RefreshCcw size={17} />
              Atualizar
            </button>
            <button
              type="button"
              onClick={startIptvOrgEpg}
              disabled={busy || epgJob?.status === 'running'}
              className="inline-flex items-center gap-2 rounded bg-ocean px-5 py-3 text-sm font-black text-ink hover:bg-cyan-300 disabled:opacity-60"
            >
              <CalendarDays size={17} />
              Importar iptv-org Brasil
            </button>
          </div>
        </form>

        <aside className="rounded border border-white/10 bg-white/6 p-5">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded bg-white text-ink">
              <CalendarDays size={21} />
            </div>
            <div>
              <h2 className="text-xl font-black text-white">Programacao</h2>
              <p className="text-sm text-slate-400">{epgJob?.message || 'Sem importacao EPG ativa'}</p>
            </div>
          </div>

          {epgJob ? (
            <div className="space-y-4">
              <div>
                <div className="mb-2 flex justify-between text-sm text-slate-300">
                  <span>{epgJob.status}</span>
                  <span>{epgJob.processed}/{epgJob.totalPrograms}</span>
                </div>
                <div className="h-3 overflow-hidden rounded bg-black/40">
                  <div className="h-full rounded bg-ocean transition-all" style={{ width: `${epgPercent}%` }} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <StatBox label="Importados" value={epgJob.imported} />
                <StatBox label="Canais" value={epgJob.matchedChannels} />
                <StatBox label="Erros" value={epgJob.errors} />
                <StatBox label="Progresso" value={`${epgPercent}%`} />
              </div>
              {epgJob.commandLog?.length > 0 && (
                <div className="max-h-32 overflow-y-auto rounded bg-black/24 p-3 text-xs text-slate-300">
                  {epgJob.commandLog.map((line, index) => (
                    <p key={`${line}-${index}`} className="truncate">{line}</p>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <StatBox label="Programas" value={epgStatus?.programs ?? 0} />
              <StatBox label="Canais" value={epgStatus?.channels ?? 0} />
            </div>
          )}

          {epgStatus?.lastImportedAt && (
            <p className="mt-4 text-sm text-slate-400">
              Ultima importacao: {new Date(epgStatus.lastImportedAt).toLocaleString('pt-BR')}
            </p>
          )}
        </aside>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
        <form onSubmit={saveTmdbSettings} className="rounded border border-white/10 bg-white/6 p-5">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded bg-gold text-ink">
              <KeyRound size={21} />
            </div>
            <div>
              <h2 className="text-xl font-black text-white">TMDB</h2>
              <p className="text-sm text-slate-400">
                {tmdbStatus?.configured
                  ? `Conectado em ${tmdbStatus.language}${omdbStatus?.configured ? ' + OMDb fallback' : ''}`
                  : 'Cole uma chave gratuita do The Movie Database. OMDb pode ser usado como fallback.'}
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-sm font-bold text-slate-200">API key</span>
              <input
                value={tmdbApiKey}
                onChange={(event) => setTmdbApiKey(event.target.value)}
                className="mt-2 w-full rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none placeholder:text-slate-500"
                placeholder={tmdbStatus?.apiKeyMasked || 'TMDB_API_KEY'}
              />
            </label>
            <label className="block">
              <span className="text-sm font-bold text-slate-200">Access token</span>
              <input
                value={tmdbAccessToken}
                onChange={(event) => setTmdbAccessToken(event.target.value)}
                className="mt-2 w-full rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none placeholder:text-slate-500"
                placeholder={tmdbStatus?.accessTokenMasked || 'Opcional'}
              />
            </label>
            <label className="block">
              <span className="text-sm font-bold text-slate-200">OMDb API key</span>
              <input
                value={omdbApiKey}
                onChange={(event) => setOmdbApiKey(event.target.value)}
                className="mt-2 w-full rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none placeholder:text-slate-500"
                placeholder={omdbStatus?.apiKeyMasked || 'Fallback opcional'}
              />
            </label>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-[160px_160px_1fr]">
            <label className="block">
              <span className="text-sm font-bold text-slate-200">Idioma</span>
              <input
                value={tmdbLanguage}
                onChange={(event) => setTmdbLanguage(event.target.value)}
                className="mt-2 w-full rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none"
              />
            </label>
            <label className="block">
              <span className="text-sm font-bold text-slate-200">Limite</span>
              <input
                value={tmdbLimit}
                onChange={(event) => setTmdbLimit(event.target.value)}
                type="number"
                min="1"
                max="2000"
                className="mt-2 w-full rounded border border-white/10 bg-black/24 px-3 py-3 text-white outline-none"
              />
            </label>
            <div className="mt-7 grid grid-cols-2 overflow-hidden rounded border border-white/10 bg-black/18 p-1">
              <button
                type="button"
                onClick={() => setTmdbMode('missing')}
                className={`rounded px-3 py-2 text-sm font-bold ${tmdbMode === 'missing' ? 'bg-white text-ink' : 'text-slate-300 hover:bg-white/8'}`}
              >
                So faltantes
              </button>
              <button
                type="button"
                onClick={() => setTmdbMode('replace')}
                className={`rounded px-3 py-2 text-sm font-bold ${tmdbMode === 'replace' ? 'bg-white text-ink' : 'text-slate-300 hover:bg-white/8'}`}
              >
                Substituir tudo
              </button>
            </div>
          </div>

          <label className="mt-4 flex items-center gap-3 rounded border border-white/10 bg-black/18 px-3 py-3 text-sm text-slate-200">
            <input checked={tmdbRunAll} onChange={(event) => setTmdbRunAll(event.target.checked)} type="checkbox" className="size-4 accent-brand" />
            Processar todos os lotes automaticamente
          </label>

          {tmdbMessage && <p className="mt-4 text-sm text-slate-300">{tmdbMessage}</p>}

          <div className="mt-5 flex flex-wrap gap-3">
            <button disabled={busy} className="inline-flex items-center gap-2 rounded bg-white px-5 py-3 text-sm font-black text-ink hover:bg-slate-200 disabled:opacity-60">
              <KeyRound size={17} />
              Salvar TMDB
            </button>
            <button
              type="button"
              onClick={startTmdbEnrichment}
              disabled={busy || ['queued', 'running', 'paused'].includes(enrichJob?.status)}
              className="inline-flex items-center gap-2 rounded bg-brand px-5 py-3 text-sm font-black text-white hover:bg-red-600 disabled:opacity-60"
            >
              <Image size={17} />
              Iniciar fila
            </button>
          </div>
        </form>

        <aside className="rounded border border-white/10 bg-white/6 p-5">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded bg-white text-ink">
              <Image size={21} />
            </div>
            <div>
              <h2 className="text-xl font-black text-white">Capas</h2>
              <p className="text-sm text-slate-400">{enrichJob?.message || 'Sem atualizacao ativa'}</p>
            </div>
          </div>

          {enrichJob ? (
            <div className="space-y-4">
              <div>
                <div className="mb-2 flex justify-between text-sm text-slate-300">
                  <span>{enrichJob.status}</span>
                  <span>{enrichJob.processed}/{enrichJob.total}</span>
                </div>
                <div className="h-3 overflow-hidden rounded bg-black/40">
                  <div
                    className="h-full rounded bg-ocean transition-all"
                    style={{ width: `${enrichJob.total ? Math.round((enrichJob.processed / enrichJob.total) * 100) : 0}%` }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <StatBox label="Encontradas" value={enrichJob.matched} />
                <StatBox label="Sem match" value={enrichJob.skipped} />
                <StatBox label="Erros" value={enrichJob.errors} />
                <StatBox label="Lote" value={enrichJob.batch || 0} />
              </div>
              <div className="flex flex-wrap gap-2">
                {enrichJob.status === 'running' && (
                  <button onClick={() => controlTmdbJob('pause')} className="rounded border border-white/10 px-3 py-2 text-sm font-bold text-slate-200 hover:bg-white/8">
                    Pausar
                  </button>
                )}
                {enrichJob.status === 'paused' && (
                  <button onClick={() => controlTmdbJob('resume')} className="rounded bg-white px-3 py-2 text-sm font-black text-ink hover:bg-slate-200">
                    Continuar
                  </button>
                )}
                {['running', 'paused', 'queued'].includes(enrichJob.status) && (
                  <button onClick={() => controlTmdbJob('stop')} className="rounded border border-white/10 px-3 py-2 text-sm font-bold text-slate-200 hover:bg-white/8">
                    Parar
                  </button>
                )}
              </div>
              {enrichJob.errorSamples?.length > 0 && (
                <div className="rounded bg-red-950/30 p-3 text-xs text-red-200">
                  {enrichJob.errorSamples.map((sample) => (
                    <p key={sample} className="truncate">{sample}</p>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-400">Depois de configurar o TMDB, use este painel para corrigir posters e backdrops em lotes.</p>
          )}
        </aside>
      </section>
    </div>
  );
}
