import { Navigate, Route, Routes } from 'react-router-dom';
import StatusPage from './pages/StatusPage';
import AdminLogin from './admin/AdminLogin';
import AdminLayout from './admin/AdminLayout';
import { IncidentsPage, MaintenancePage, ServicesPage, ContainersPage, AlertsPage } from './admin/pages';
import { tokenStore } from './api';

function RequireAuth({ children }) {
  return tokenStore.get() ? children : <Navigate to="/admin/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<StatusPage />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<RequireAuth><AdminLayout /></RequireAuth>}>
        <Route index element={<Navigate to="incidents" replace />} />
        <Route path="incidents" element={<IncidentsPage />} />
        <Route path="maintenance" element={<MaintenancePage />} />
        <Route path="services" element={<ServicesPage />} />
        <Route path="containers" element={<ContainersPage />} />
        <Route path="alerts" element={<AlertsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
