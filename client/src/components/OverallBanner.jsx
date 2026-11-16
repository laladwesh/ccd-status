import dayjs from 'dayjs';
import { OVERALL_META } from '../constants';

export default function OverallBanner({ overall, generatedAt, connected, source }) {
  const meta = OVERALL_META[overall?.status] || { color: '#5F6A82' };
  return (
    <section className="text-white px-5 py-5" style={{ background: meta.color }} aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl sm:text-2xl">{overall?.message || 'Checking…'}</h2>
        <div className="flex items-center gap-2 text-sm opacity-95">
          <span
            className={`inline-block w-2.5 h-2.5 rounded-full ${connected ? 'live-dot' : ''}`}
            style={{ background: connected ? '#9BE59B' : '#D9D9D9' }}
            title={connected ? 'Live updates connected' : source === 'cache' ? 'Cached' : 'Polling'}
          />
          <span>{connected ? 'Live' : 'Polling'} · updated {generatedAt ? dayjs(generatedAt).format('HH:mm:ss') : '–'}</span>
        </div>
      </div>
      {meta.note && <p className="mt-2 text-sm opacity-95">{meta.note}</p>}
    </section>
  );
}
