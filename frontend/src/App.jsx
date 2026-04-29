import React, { useContext } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, AuthContext } from './context/AuthContext';
import AuthScreen from './pages/AuthScreen';
import DashboardScreen from './pages/DashboardScreen';
import QuizSetupScreen from './pages/QuizSetupScreen';
import QuizRoundScreen from './pages/QuizRoundScreen';
import ResultsScreen from './pages/ResultsScreen';

const PrivateRoute = ({ children }) => {
  const { token, loading } = useContext(AuthContext);
  if (loading) return <div>Loading...</div>;
  return token ? children : <Navigate to="/login" />;
};

const AppRoutes = () => {
  return (
    <div className="min-h-screen bg-gray-100 font-sans text-gray-900">
      <nav className="bg-white shadow-sm py-4 px-8 flex justify-between items-center">
        <div className="text-2xl font-black text-indigo-600 tracking-tighter">
          🎧 MUSIC TRIVIA
        </div>
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
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;