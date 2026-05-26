import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import AdminPage from './pages/AdminPage.jsx';
import CatalogPage from './pages/CatalogPage.jsx';
import Home from './pages/Home.jsx';
import MovieDetails from './pages/MovieDetails.jsx';
import PlayerPage from './pages/PlayerPage.jsx';
import ProblemsPage from './pages/ProblemsPage.jsx';
import SearchPage from './pages/SearchPage.jsx';
import SeriesDetails from './pages/SeriesDetails.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="/filmes" element={<CatalogPage type="movie" />} />
          <Route path="/series" element={<CatalogPage type="series" />} />
          <Route path="/canais" element={<CatalogPage type="channel" />} />
          <Route path="/movies/:id" element={<MovieDetails />} />
          <Route path="/series/:id" element={<SeriesDetails />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/problemas" element={<ProblemsPage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Route>
        <Route path="/watch/:type/:id" element={<PlayerPage />} />
      </Routes>
    </BrowserRouter>
  );
}
