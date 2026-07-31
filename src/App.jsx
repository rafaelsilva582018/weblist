import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import Home from './pages/Home.jsx';
import LoginPage from './pages/LoginPage.jsx';

function lazyPage(loader) {
  const Component = lazy(loader);
  Component.preload = loader;
  return Component;
}

const CatalogPage = lazyPage(() => import('./pages/CatalogPage.jsx'));
const FavoritesPage = lazyPage(() => import('./pages/FavoritesPage.jsx'));
const ProfilePage = lazyPage(() => import('./pages/ProfilePage.jsx'));
const MovieDetails = lazyPage(() => import('./pages/MovieDetails.jsx'));
const SeriesDetails = lazyPage(() => import('./pages/SeriesDetails.jsx'));
const SearchPage = lazyPage(() => import('./pages/SearchPage.jsx'));
const PlayerPage = lazyPage(() => import('./pages/PlayerPage.jsx'));
const ProblemsPage = lazyPage(() => import('./pages/ProblemsPage.jsx'));
const AdminPage = lazyPage(() => import('./pages/AdminPage.jsx'));
const RandomPage = lazyPage(() => import('./pages/RandomPage.jsx'));

const sharedWarmPages = [CatalogPage, FavoritesPage, ProfilePage, SearchPage, MovieDetails, SeriesDetails, PlayerPage, RandomPage];
const adminWarmPages = [ProblemsPage, AdminPage];

function scheduleWarmPages(warmers) {
  const run = () => {
    warmers.forEach((page) => page.preload?.().catch?.(() => {}));
  };

  if (typeof window === 'undefined') return () => {};
  if (typeof window.requestIdleCallback === 'function') {
    const idleId = window.requestIdleCallback(run, { timeout: 1800 });
    return () => window.cancelIdleCallback?.(idleId);
  }

  const timeoutId = window.setTimeout(run, 900);
  return () => window.clearTimeout(timeoutId);
}

function LoadingScreen() {
  return (
    <div className="grid min-h-screen place-items-center bg-ink px-4 text-center text-white">
      <div>
        <span className="mx-auto grid size-12 place-items-center rounded bg-brand text-lg font-black shadow-glow">W</span>
        <p className="mt-4 text-sm text-slate-400">Abrindo sua biblioteca...</p>
      </div>
    </div>
  );
}

function PageLoadingState() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 text-sm text-slate-400 sm:px-6 lg:px-8">
      Carregando pagina...
    </div>
  );
}

function RouteSuspense({ children, fullScreen = false }) {
  return <Suspense fallback={fullScreen ? <LoadingScreen /> : <PageLoadingState />}>{children}</Suspense>;
}

function ProtectedApp() {
  const { status, user } = useAuth();

  useEffect(() => {
    if (status !== 'authenticated' || !user) return undefined;
    return scheduleWarmPages(user.isAdmin ? [...sharedWarmPages, ...adminWarmPages] : sharedWarmPages);
  }, [status, user]);

  if (status === 'loading') return <LoadingScreen />;
  if (!user) return <LoginPage />;
  return <Outlet />;
}

function LoginRoute() {
  const { status, user } = useAuth();
  if (status === 'loading') return <LoadingScreen />;
  if (user) return <Navigate to="/" replace />;
  return <LoginPage />;
}

function AdminOnly({ children }) {
  const { user } = useAuth();
  if (user?.isAdmin) return children;

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 lg:px-8">
      <h1 className="text-3xl font-black text-white">Acesso restrito</h1>
      <p className="mt-3 text-sm text-slate-400">Somente o administrador pode abrir esta area.</p>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          <Route element={<ProtectedApp />}>
            <Route element={<Layout />}>
              <Route index element={<Home />} />
              <Route path="/filmes" element={<RouteSuspense><CatalogPage type="movie" /></RouteSuspense>} />
              <Route path="/series" element={<RouteSuspense><CatalogPage type="series" /></RouteSuspense>} />
              <Route path="/canais" element={<RouteSuspense><CatalogPage type="channel" /></RouteSuspense>} />
              <Route path="/favoritos" element={<RouteSuspense><FavoritesPage /></RouteSuspense>} />
              <Route path="/sorteador" element={<RouteSuspense><RandomPage /></RouteSuspense>} />
              <Route path="/perfil" element={<RouteSuspense><ProfilePage /></RouteSuspense>} />
              <Route path="/movies/:id" element={<RouteSuspense><MovieDetails /></RouteSuspense>} />
              <Route path="/series/:id" element={<RouteSuspense><SeriesDetails /></RouteSuspense>} />
              <Route path="/search" element={<RouteSuspense><SearchPage /></RouteSuspense>} />
              <Route
                path="/problemas"
                element={
                  <AdminOnly>
                    <RouteSuspense>
                      <ProblemsPage />
                    </RouteSuspense>
                  </AdminOnly>
                }
              />
              <Route
                path="/admin"
                element={
                  <AdminOnly>
                    <RouteSuspense>
                      <AdminPage />
                    </RouteSuspense>
                  </AdminOnly>
                }
              />
            </Route>
            <Route path="/watch/:type/:id" element={<RouteSuspense fullScreen><PlayerPage /></RouteSuspense>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
