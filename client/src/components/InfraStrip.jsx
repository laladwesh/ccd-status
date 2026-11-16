import { Card } from 'antd';
import { stateMeta } from '../constants';

const ORDER = ['server', 'dns', 'gateway', 'tls', 'database'];

export default function InfraStrip({ infra }) {
  if (!infra) return null;
  return (
    <Card size="small" title="Infrastructure" styles={{ body: { padding: 0 } }}>
      <div className="grid grid-cols-2 sm:grid-cols-5">
        {ORDER.filter((k) => infra[k]).map((k) => {
          const n = infra[k];
          const m = stateMeta(n.state);
          return (
            <div key={k} className="px-4 py-3 border-t sm:border-t-0 sm:border-l first:border-l-0 first:border-t-0" style={{ borderColor: '#EDF0F5' }}>
              <div className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: m.color }} />
                <span className="text-sm font-medium text-[#161B22]">{n.label}</span>
              </div>
              <div className="text-xs text-[#666B72] mt-1 truncate" title={n.detail || m.label}>{n.detail || m.label}</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
