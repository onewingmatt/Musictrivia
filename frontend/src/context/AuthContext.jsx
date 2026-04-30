import React, { createContext, useState, useEffect } from 'react';
import api from '../api';

export const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
        const isGuest = localStorage.getItem('isGuest') === 'true';
        setUser({ username: localStorage.getItem('username') || 'User', isGuest });
    }
    setLoading(false);
  }, [token]);

  const login = async (username, password) => {
    const res = await api.post('/auth/login', { username, password });
    localStorage.setItem('token', res.data.token);
    localStorage.setItem('username', res.data.user.username);
    setToken(res.data.token);
    setUser(res.data.user);
  };

  const register = async (username, password) => {
    const res = await api.post('/auth/register', { username, password });
    localStorage.setItem('token', res.data.token);
    localStorage.setItem('username', res.data.user.username);
    setToken(res.data.token);
    setUser(res.data.user);
  };

  const guestLogin = () => {
    const guestNum = Math.floor(Math.random() * 9000 + 1000);
    const guestName = `Guest_${guestNum}`;
    localStorage.setItem('token', 'guest');
    localStorage.setItem('username', guestName);
    localStorage.setItem('isGuest', 'true');
    setToken('guest');
    setUser({ username: guestName, isGuest: true });
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    localStorage.removeItem('isGuest');
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, login, register, guestLogin, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
};
