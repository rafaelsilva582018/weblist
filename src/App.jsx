import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import AdminPage from './pages/AdminPage.jsx';
import CatalogPage from './pages/CatalogPage.jsx';
import FavoritesPage from './pages/FavoritesPage.jsx';
import Home from './pages/Home.jsx';
import LoginPage from './pages/LoginPage.jsx';
import MovieDetails from './pages/MovieDetails.jsx';
import PlayerPage from './pages/PlayerPage.jsx';
import ProblemsPage from './pages/ProblemsPage.jsx';
import SearchPage from './pages/SearchPage.jsx';
import SeriesDetails from './pages/SeriesDetails.jsx';

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

function ProtectedApp() {
  const { status, user } = useAuth();
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
              <Route path="/filmes" element={<CatalogPage type="movie" />} />
              <Route path="/series" element={<CatalogPage type="series" />} />
              <Route path="/canais" element={<CatalogPage type="channel" />} />
              <Route path="/favoritos" element={<FavoritesPage />} />
              <Route path="/movies/:id" element={<MovieDetails />} />
              <Route path="/series/:id" element={<SeriesDetails />} />
              <Route path="/search" element={<SearchPage />} />
              <Route
                path="/problemas"
                element={
                  <AdminOnly>
                    <ProblemsPage />
                  </AdminOnly>
                }
              />
              <Route
                path="/admin"
                element={
                  <AdminOnly>
                    <AdminPage />
                  </AdminOnly>
                }
              />
            </Route>
            <Route path="/watch/:type/:id" element={<PlayerPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
