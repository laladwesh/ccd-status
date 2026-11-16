import { useMemo, useState } from 'react';
import { Alert, Button, Card, Spin } from 'antd';
import dayjs from 'dayjs';
import TopBar from '../components/TopBar';
import Footer from '../components/Footer';
import OverallBanner from '../components/OverallBanner';
import InfraStrip from '../components/InfraStrip';
import ServiceRow from '../components/ServiceRow';
import ServiceDrawer from '../components/ServiceDrawer';
import { ActiveNotices, IncidentHistory } from '../components/IncidentsView';
import { useStatus } from '../hooks/useStatus';
import { GROUPS } from '../constants';

export default function StatusPage() {
  const { data, source, connected, failed, reload } = useStatus();
  const [selected, setSelected] = useState(null);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const s of data?.services || []) {
      if (!map.has(s.group)) map.set(s.group, []);
      map.get(s.group).push(s);
    }
    const known = GROUPS.filter((g) => map.has(g));
    const extra = [...map.keys()].filter((g) => !GROUPS.includes(g));
    return [...known, ...extra].map((g) => [g, map.get(g)]);
  }, [data]);

  const nameOf = (key) => data?.services?.find((s) => s.key === key)?.name || key;
  const selectedLive = selected && data?.services?.find((s) => s.key === selected.key);

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar />
      <main className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-5 flex flex-col gap-5">
        {source === 'cache' && data && (
          <Alert
            type="warning" showIcon
            message={`Showing cached status from ${dayjs(data.generatedAt).format('HH:mm')}`}
            description="The live API is not reachable right now. This is the last snapshot saved by the monitoring worker."
            action={<Button size="small" onClick={reload}>Retry</Button>}
          />
        )}
        {data?.stale && source === 'live' && (
          <Alert type="warning" showIcon message="Monitoring is not reporting" description={`The last check was at ${dayjs(data.generatedAt).format('HH:mm')}. The statuses below may be out of date.`} />
        )}

        {!data && !failed && <div className="py-24 text-center"><Spin size="large" /></div>}
        {!data && failed && (
          <Alert type="error" showIcon message="Status unavailable" description="Neither the live API nor the cached snapshot could be loaded. Please try again shortly." action={<Button size="small" onClick={reload}>Retry</Button>} />
        )}

        {data && (
          <>
            <OverallBanner overall={data.overall} generatedAt={data.generatedAt} connected={connected} source={source} />
            <ActiveNotices incidents={data.incidents?.active} maintenance={data.maintenance} nameOf={nameOf} />
            <InfraStrip infra={data.infra} />
            {grouped.map(([group, list]) => (
              <Card key={group} size="small" title={group} styles={{ body: { padding: 0 } }}>
                {list.map((s) => <ServiceRow key={s.key} service={s} onOpen={setSelected} />)}
              </Card>
            ))}
            <Card size="small" title="Incident history">
              <IncidentHistory incidents={[...(data.incidents?.active || []), ...(data.incidents?.recent || [])]} />
            </Card>
          </>
        )}
      </main>
      <Footer />
      <ServiceDrawer service={selectedLive || selected} onClose={() => setSelected(null)} />
    </div>
  );
}
