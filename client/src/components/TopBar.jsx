import { TeamOutlined } from '@ant-design/icons';
import logo from '../assets/iitglogo.png';
import { TEAM_URL } from '../constants';

// Placement-portal TopNavBar styling: flat white bar, hairline border, IITG logo, no sidebar.
export default function TopBar({ right }) {
  return (
    <header className="bg-white border-b" style={{ borderColor: '#E4E1E0' }}>
      <nav className="max-w-5xl mx-auto flex items-center justify-between px-4 sm:px-6 py-3 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <img src={logo} alt="IIT Guwahati" className="w-[42px] h-[42px] shrink-0" />
          <div className="min-w-0">
            <h1 className="text-[1.18rem] leading-tight text-[#1b2430] truncate">CCD System Status</h1>
            <p className="text-xs text-[#666B72] truncate">Centre for Career Development, IIT Guwahati</p>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-4">
          {right}
          <a
            href={TEAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Meet the Team"
            title="Meet the Team"
            className="flex items-center gap-1.5 text-[#14213D] font-semibold text-sm no-underline hover:text-[#7C2D3E] transition-colors"
          >
            <TeamOutlined />
            {/* icon only on mobile, text from the sm breakpoint up */}
            <span className="hidden sm:inline">Meet the Team</span>
          </a>
        </div>
      </nav>
    </header>
  );
}
