import React, { useContext } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, AuthContext } from './context/AuthContext';
import { ThemeProvider, ThemeContext } from './context/ThemeContext';
import AuthScreen from './pages/AuthScreen';
import DashboardScreen from './pages/DashboardScreen';
import QuizSetupScreen from './pages/QuizSetupScreen';
import QuizRoundScreen from './pages/QuizRoundScreen';
import ResultsScreen from './pages/ResultsScreen';

const PrivateRoute = ({ children }) => {
  const { token, loading } = useContext(AuthContext);
  if (loading) return <div className="text-gray-900 dark:text-gray-100">Loading...</div>;
  return token ? children : <Navigate to="/login" />;
};

const ThemeToggle = () => {
  const { dark, toggleTheme } = useContext(ThemeContext);
  return (
    <button
      onClick={toggleTheme}
      className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition"
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {dark ? (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
          <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
        </svg>
      )}
    </button>
  );
};

const AppRoutes = () => {
  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 font-sans text-gray-900 dark:text-gray-100 transition-colors">
      <nav className="bg-white dark:bg-gray-800 shadow-sm py-4 px-8 flex justify-between items-center transition-colors">
        <div className="text-2xl font-black text-indigo-600 dark:text-indigo-400 tracking-tighter">
          MUSIC TRIVIA
        </div>
        <ThemeToggle />
      </nav>
      <main className="p-4">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" />} />
          <Route path="/login" element={<AuthScreen isLogin={true} />} />
          <Route path="/register" element={<AuthScreen isLogin={false} />} />
          <Route
            path="/dashboard"
            element={<PrivateRoute><DashboardScreen /></PrivateRoute>}
          />
          <Route
            path="/setup"
            element={<PrivateRoute><QuizSetupScreen /></PrivateRoute>}
          />
          <Route
            path="/play"
            element={<PrivateRoute><QuizRoundScreen /></PrivateRoute>}
          />
          <Route
            path="/results"
            element={<PrivateRoute><ResultsScreen /></PrivateRoute>}
          />
        </Routes>
      </main>
    </div>
  );
};

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
