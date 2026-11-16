import { useState } from 'react';
import { Drawer } from 'antd';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  AlertOutlined, BellOutlined, CloseOutlined, DashboardOutlined, LogoutOutlined, MenuOutlined, ToolOutlined, ContainerOutlined,
} from '@ant-design/icons';
import logo from '../assets/iitglogo.png';
import { tokenStore } from '../api';

const NAV = [
  { to: 'incidents', label: 'Incidents', icon: <AlertOutlined /> },
  { to: 'maintenance', label: 'Maintenance', icon: <ToolOutlined /> },
  { to: 'services', label: 'Services', icon: <DashboardOutlined /> },
  { to: 'containers', label: 'Containers', icon: <ContainerOutlined /> },
  { to: 'alerts', label: 'Alerts', icon: <BellOutlined /> },
];

// Mirrors the Placement SideNavBar: white panel, hairline right border, brand header, 14px rows with tint hover.
function SideNav({ onNavigate }) {
  const linkCls = ({ isActive }) =>
    `flex items-center gap-2.5 px-3 py-[9px] text-sm no-underline rounded-lg transition-colors ${
      isActive ? 'bg-brand-100 text-brand-700 font-medium' : 'text-[#46505e] hover:bg-brand-50 hover:text-brand-700'}`;
  return (
    <div className="h-full flex flex-col justify-between bg-white">
      <div className="px-3.5 pb-4">
        <div className="flex items-center px-2 pt-5 pb-4 mb-2 border-b" style={{ borderColor: '#f1f2f4' }}>
          <img src={logo} alt="" className="w-[42px] h-[42px] mr-3" />
          <span className="text-[1.18rem] leading-[1.15] text-[#1b2430]">Status Admin</span>
        </div>
        <ul className="list-none">
          {NAV.map((n) => (
            <li key={n.to} className="my-0.5" style={{ listStyle: 'none' }}>
              <NavLink to={n.to} className={linkCls} onClick={onNavigate}>{n.icon}<span>{n.label}</span></NavLink>
            </li>
          ))}
          <li className="my-0.5" style={{ listStyle: 'none' }}>
            <a href="../" className="flex items-center gap-2.5 px-3 py-[9px] text-sm no-underline rounded-lg text-[#46505e] hover:bg-brand-50 hover:text-brand-700">
              <DashboardOutlined /><span>Public page</span>
            </a>
          </li>
        </ul>
      </div>
      <p className="px-4 pb-6 text-[13px] font-semibold text-black">Technical Support Team, CCD, IITG</p>
    </div>
  );
}

export default function AdminLayout() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const logout = () => { tokenStore.clear(); nav('/admin/login', { replace: true }); };

  return (
    <div className="min-h-screen">
      <aside className="hidden lg:block fixed top-0 left-0 w-[240px] h-screen border-r" style={{ borderColor: '#eceef1', boxShadow: '0 1px 3px rgba(16,24,40,0.04)' }}>
        <SideNav />
      </aside>
      <Drawer placement="left" open={open} onClose={() => setOpen(false)} width={280} closeIcon={<CloseOutlined />} styles={{ body: { padding: 0 } }}>
        <SideNav onNavigate={() => setOpen(false)} />
      </Drawer>

      <div className="lg:pl-[240px]">
        <nav className="flex items-center justify-between px-6 py-4">
          <button type="button" className="lg:hidden text-brand-700 text-base bg-transparent border-0 cursor-pointer" onClick={() => setOpen(true)} aria-label="Open menu"><MenuOutlined /></button>
          <span className="hidden lg:block" />
          <button type="button" onClick={logout} className="text-sm text-brand-700 bg-transparent border-0 cursor-pointer flex items-center gap-2"><LogoutOutlined /> Sign out</button>
        </nav>
        <main className="px-4 sm:px-6 pb-12"><Outlet /></main>
      </div>
    </div>
  );
}
