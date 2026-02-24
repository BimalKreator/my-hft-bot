import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import Login from './pages/Login';
import DashboardLayout from './layouts/DashboardLayout';
import Dashboard from './pages/Dashboard';
import ExchangeSetup from './pages/ExchangeSetup';
import BotStatus from './pages/BotStatus';
import Scanner from './pages/Scanner';
import Settings from './pages/Settings';
import Logs from './pages/Logs';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (token) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      {/* Default page: Login (unauthenticated users see Login first) */}
      <Route
        path="/login"
        element={
          <PublicRoute>
            <Login />
          </PublicRoute>
        }
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="exchange-setup" element={<ExchangeSetup />} />
        <Route path="bot" element={<BotStatus />} />
        <Route path="scanner" element={<Scanner />} />
        <Route path="settings" element={<Settings />} />
        <Route path="logs" element={<Logs />} />
      </Route>
      {/* Any other path → redirect to login (default page) */}
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
