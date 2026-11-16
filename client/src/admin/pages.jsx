import { useCallback, useEffect, useState } from 'react';
import { Button, DatePicker, Form, Input, Modal, Popconfirm, Select, Switch, Table, Tag, message } from 'antd';
import { ReloadOutlined, PlusOutlined, SendOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api';
import StatusTag from '../components/StatusTag';
import { humanUptime } from '../components/ServiceDrawer';
import { INCIDENT_COLOR, INCIDENT_STATUS } from '../constants';

const fmt = (d) => (d ? dayjs(d).format('D MMM YYYY, HH:mm') : '–');
const errText = (e) => e?.response?.data?.error || e?.message || 'Request failed';

function PageHead({ title, children }) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
      <h2 className="text-xl text-[#1b2430]">{title}</h2>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

function useList(url, pick = (d) => d) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(pick((await api.get(url)).data)); } catch (e) { message.error(errText(e)); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  useEffect(() => { load(); }, [load]);
  return [data, loading, load];
}

function useServiceOptions() {
  const [services] = useList('/admin/services');
  return services.map((s) => ({ value: s.key, label: s.name }));
}

// ---------------- Incidents ----------------
export function IncidentsPage() {
  const [rows, loading, reload] = useList('/admin/incidents');
  const options = useServiceOptions();
  const [createOpen, setCreateOpen] = useState(false);
  const [updating, setUpdating] = useState(null);
  const [form] = Form.useForm();
  const [uform] = Form.useForm();
  const nameOf = (k) => options.find((o) => o.value === k)?.label || k;

  const create = async (v) => {
    try { await api.post('/admin/incidents', v); message.success('Incident created'); setCreateOpen(false); form.resetFields(); reload(); } catch (e) { message.error(errText(e)); }
  };
  const addUpdate = async (v) => {
    try { await api.post(`/admin/incidents/${updating.id}/updates`, v); message.success('Update posted'); setUpdating(null); uform.resetFields(); reload(); } catch (e) { message.error(errText(e)); }
  };
  const remove = async (id) => { try { await api.delete(`/admin/incidents/${id}`); reload(); } catch (e) { message.error(errText(e)); } };

  return (
    <>
      <PageHead title="Incidents">
        <Button icon={<ReloadOutlined />} onClick={reload}>Refresh</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>New incident</Button>
      </PageHead>
      <p className="text-sm text-[#666B72] mb-3">Incidents are opened and resolved automatically by the worker. You can add notes, change status, or create manual incidents.</p>
      <Table
        rowKey="id" loading={loading} dataSource={rows} scroll={{ x: 800 }} size="middle"
        expandable={{ expandedRowRender: (r) => (r.updates?.length ? r.updates.map((u) => <div key={u._id || u.ts} className="text-sm py-0.5"><span className="text-[#666B72]">{fmt(u.ts)} · {u.author}</span> — {u.message}</div>) : <span className="text-sm text-[#666B72]">No updates</span>) }}
        columns={[
          { title: 'Title', dataIndex: 'title' },
          { title: 'Status', dataIndex: 'status', width: 130, render: (s) => <Tag color={INCIDENT_COLOR[s]}>{s}</Tag> },
          { title: 'Scope', dataIndex: 'serviceKeys', render: (k) => (k?.length ? k.map((x) => (x.startsWith('infra:') ? x.replace('infra:', '') : nameOf(x))).join(', ') : 'general') },
          { title: 'Started', dataIndex: 'startedAt', width: 170, render: fmt },
          { title: 'Resolved', dataIndex: 'resolvedAt', width: 170, render: fmt },
          { title: 'Source', dataIndex: 'autoCreated', width: 90, render: (a) => (a ? 'auto' : 'manual') },
          {
            title: '', key: 'a', width: 170,
            render: (_, r) => (
              <span className="flex gap-2">
                <Button size="small" onClick={() => { setUpdating(r); uform.setFieldsValue({ status: r.status }); }}>Add update</Button>
                <Popconfirm title="Delete this incident?" onConfirm={() => remove(r.id)}><Button size="small" danger>Delete</Button></Popconfirm>
              </span>
            ),
          },
        ]}
      />
      <Modal title="New incident" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} okText="Create" destroyOnClose>
        <Form form={form} layout="vertical" onFinish={create} initialValues={{ status: 'investigating', serviceKeys: [] }}>
          <Form.Item name="title" label="Title" rules={[{ required: true }]}><Input maxLength={200} /></Form.Item>
          <Form.Item name="serviceKeys" label="Affected services"><Select mode="multiple" options={options} placeholder="Leave empty for a general incident" /></Form.Item>
          <Form.Item name="status" label="Status"><Select options={INCIDENT_STATUS.map((s) => ({ value: s, label: s }))} /></Form.Item>
          <Form.Item name="message" label="Message"><Input.TextArea rows={3} maxLength={2000} /></Form.Item>
        </Form>
      </Modal>
      <Modal title={`Update: ${updating?.title || ''}`} open={!!updating} onCancel={() => setUpdating(null)} onOk={() => uform.submit()} okText="Post update" destroyOnClose>
        <Form form={uform} layout="vertical" onFinish={addUpdate}>
          <Form.Item name="status" label="Status"><Select options={INCIDENT_STATUS.map((s) => ({ value: s, label: s }))} /></Form.Item>
          <Form.Item name="message" label="Message" rules={[{ required: true }]}><Input.TextArea rows={3} maxLength={2000} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

// ---------------- Maintenance ----------------
export function MaintenancePage() {
  const [rows, loading, reload] = useList('/admin/maintenance');
  const options = useServiceOptions();
  const [form] = Form.useForm();
  const nameOf = (k) => options.find((o) => o.value === k)?.label || k;

  const create = async (v) => {
    try {
      await api.post('/admin/maintenance', { services: v.services || [], note: v.note, start: v.range[0].toISOString(), end: v.range[1].toISOString() });
      message.success('Maintenance scheduled'); form.resetFields(); reload();
    } catch (e) { message.error(errText(e)); }
  };
  const remove = async (id) => { try { await api.delete(`/admin/maintenance/${id}`); reload(); } catch (e) { message.error(errText(e)); } };

  return (
    <>
      <PageHead title="Maintenance windows"><Button icon={<ReloadOutlined />} onClick={reload}>Refresh</Button></PageHead>
      <div className="bg-white border p-4 mb-5" style={{ borderColor: '#E4E1E0' }}>
        <p className="text-sm text-[#666B72] mb-3">During a window the selected services show "Maintenance" and no incidents or alerts are raised.</p>
        <Form form={form} layout="vertical" onFinish={create}>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Form.Item name="range" label="Window" rules={[{ required: true }]}><DatePicker.RangePicker showTime={{ format: 'HH:mm' }} format="D MMM YYYY HH:mm" className="w-full" /></Form.Item>
            <Form.Item name="services" label="Services"><Select mode="multiple" options={options} placeholder="Empty = all services" /></Form.Item>
          </div>
          <Form.Item name="note" label="Note"><Input maxLength={1000} /></Form.Item>
          <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>Schedule</Button>
        </Form>
      </div>
      <Table
        rowKey="id" loading={loading} dataSource={rows} size="middle" scroll={{ x: 700 }}
        columns={[
          { title: 'Start', dataIndex: 'start', render: fmt, width: 170 },
          { title: 'End', dataIndex: 'end', render: fmt, width: 170 },
          { title: 'Services', dataIndex: 'services', render: (s) => (s?.length ? s.map(nameOf).join(', ') : 'all') },
          { title: 'Note', dataIndex: 'note' },
          { title: '', width: 90, render: (_, r) => <Popconfirm title="Delete this window?" onConfirm={() => remove(r.id)}><Button size="small" danger>Delete</Button></Popconfirm> },
        ]}
      />
    </>
  );
}

// ---------------- Services ----------------
export function ServicesPage() {
  const [rows, loading, reload] = useList('/admin/services');
  const [busy, setBusy] = useState(null);

  const toggle = async (key, enabled) => {
    try { await api.patch(`/admin/services/${key}`, { enabled }); reload(); } catch (e) { message.error(errText(e)); }
  };
  const checkNow = async (serviceKey) => {
    setBusy(serviceKey || 'all');
    try {
      const { data } = await api.post('/admin/check-now', { serviceKey });
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const c = (await api.get(`/admin/commands/${data.id}`)).data;
        if (c.done) { message.success(c.result?.error ? c.result.error : `Checked ${c.result?.checked ?? ''}`); break; }
      }
      reload();
    } catch (e) { message.error(errText(e)); } finally { setBusy(null); }
  };

  return (
    <>
      <PageHead title="Services">
        <Button icon={<ReloadOutlined />} onClick={reload}>Refresh</Button>
        <Button type="primary" icon={<ThunderboltOutlined />} loading={busy === 'all'} onClick={() => checkNow(null)}>Check all now</Button>
      </PageHead>
      <Table
        rowKey="key" loading={loading} dataSource={rows} size="middle" pagination={false} scroll={{ x: 900 }}
        columns={[
          { title: 'Service', dataIndex: 'name' },
          { title: 'Group', dataIndex: 'group', width: 110 },
          { title: 'State', dataIndex: 'state', width: 200, render: (s) => <StatusTag state={s} short /> },
          { title: 'Container', dataIndex: 'container', width: 190 },
          { title: 'Health quality', dataIndex: 'quality', width: 120, render: (q) => <Tag color={q === 'health' ? '#107C10' : '#9CA0AE'}>{q === 'health' ? 'health route' : 'basic'}</Tag> },
          { title: 'Probes', width: 150, render: (_, r) => [r.internal && 'internal', r.public && 'public', 'container'].filter(Boolean).join(' · ') },
          { title: 'Enabled', dataIndex: 'enabled', width: 90, render: (e, r) => <Switch checked={e} onChange={(v) => toggle(r.key, v)} /> },
          { title: '', width: 120, render: (_, r) => <Button size="small" loading={busy === r.key} disabled={!r.enabled} onClick={() => checkNow(r.key)}>Check now</Button> },
        ]}
      />
    </>
  );
}

// ---------------- Containers ----------------
export function ContainersPage() {
  const [data, loading, reload] = useList('/admin/containers', (d) => d);
  const items = data?.items || [];
  return (
    <>
      <PageHead title="Containers">
        <Button icon={<ReloadOutlined />} onClick={reload}>Refresh</Button>
      </PageHead>
      <p className="text-sm text-[#666B72] mb-3">Read-only view from the Docker socket proxy. {data?.updatedAt ? `Updated ${fmt(data.updatedAt)}.` : 'No data yet: the Docker API may be unreachable from the worker.'}</p>
      <Table
        rowKey="name" loading={loading} dataSource={items} size="middle" pagination={false} scroll={{ x: 900 }}
        columns={[
          { title: 'Name', dataIndex: 'name', sorter: (a, b) => a.name.localeCompare(b.name) },
          { title: 'Image', dataIndex: 'image', ellipsis: true },
          { title: 'State', dataIndex: 'state', width: 130, render: (s, r) => <Tag color={r.restartLoop ? '#D83B01' : r.running ? '#107C10' : '#D83B01'}>{r.restartLoop ? 'restart loop' : s}</Tag> },
          { title: 'Restarts', dataIndex: 'restartCount', width: 90, sorter: (a, b) => a.restartCount - b.restartCount },
          { title: 'Exit code', dataIndex: 'exitCode', width: 90 },
          { title: 'Uptime', dataIndex: 'uptimeSec', width: 100, render: humanUptime },
          { title: 'Network', dataIndex: 'networkMode', width: 110 },
          { title: 'Health', dataIndex: 'health', width: 100, render: (h) => h || '–' },
        ]}
      />
    </>
  );
}

// ---------------- Alerts ----------------
export function AlertsPage() {
  const [ch, , reload] = useList('/admin/alerts');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const channels = Array.isArray(ch) ? {} : ch;

  const test = async () => {
    setBusy(true); setLast(null);
    try {
      const { data } = await api.post('/admin/test-alert');
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const c = (await api.get(`/admin/commands/${data.id}`)).data;
        if (c.done) { setLast(c.result); break; }
      }
      reload();
    } catch (e) { message.error(errText(e)); } finally { setBusy(false); }
  };

  const on = channels.email || channels.telegram;
  return (
    <>
      <PageHead title="Alerts" />
      <div className="bg-white border p-4 max-w-xl" style={{ borderColor: '#E4E1E0' }}>
        <p className="text-sm mb-3">Alerts are sent on state changes only (down, recovered, upstream outage, database down), batched and rate-limited. Channels are configured in the server's <code>.env</code> and are off by default.</p>
        <div className="flex gap-2 mb-4">
          <Tag color={channels.email ? '#107C10' : '#9CA0AE'}>Email: {channels.email ? 'enabled' : 'off'}</Tag>
          <Tag color={channels.telegram ? '#107C10' : '#9CA0AE'}>Telegram: {channels.telegram ? 'enabled' : 'off'}</Tag>
        </div>
        <Button type="primary" icon={<SendOutlined />} loading={busy} onClick={test}>Send test alert</Button>
        {!on && <p className="text-xs text-[#666B72] mt-2">No channel is enabled, so a test will do nothing. The dashboard itself works fully without alerts.</p>}
        {last && (
          <div className="text-sm mt-3">
            {last.error ? <span style={{ color: '#D83B01' }}>{last.error}</span> : (
              <>
                <div>Email: {last.email || 'not enabled'}</div>
                <div>Telegram: {last.telegram || 'not enabled'}</div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
