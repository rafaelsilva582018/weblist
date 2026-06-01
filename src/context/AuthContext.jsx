import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { apiFetch, getToken, setToken } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setTokenState] = useState(getToken());
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(token ? 'loading' : 'guest');

  useEffect(() => {
    if (!token) {
      setUser(null);
      setStatus('guest');
      return undefined;
    }

    let active = true;
    setStatus('loading');
    apiFetch('/auth/me')
      .then((data) => {
        if (!active) return;
        setUser(data.user);
        setStatus('authenticated');
      })
      .catch(() => {
        if (!active) return;
        setToken(null);
        setTokenState(null);
        setUser(null);
        setStatus('guest');
      });

    return () => {
      active = false;
    };
  }, [token]);

  async function login(credentials) {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: credentials
    });
    setToken(data.token);
    setTokenState(data.token);
    setUser(data.user);
    setStatus('authenticated');
    return data;
  }

  function logout() {
    setToken(null);
    setTokenState(null);
    setUser(null);
    setStatus('guest');
  }

  const value = useMemo(
    () => ({
      token,
      user,
      status,
      login,
      logout
    }),
    [token, user, status]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth precisa estar dentro de AuthProvider');
  return context;
}
