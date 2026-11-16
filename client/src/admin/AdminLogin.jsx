import { useState } from 'react';
import { Alert, Button, Card, Form, Input } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api, tokenStore } from '../api';
import logo from '../assets/iitglogo.png';

export default function AdminLogin() {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const onFinish = async (v) => {
    setBusy(true); setError('');
    try {
      const r = await api.post('/admin/login', v);
      tokenStore.set(r.data.token);
      nav('/admin', { replace: true });
    } catch (e) {
      setError(e.response?.status === 429 ? 'Too many attempts. Try again later.' : 'Invalid username or password.');
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-sm" styles={{ body: { padding: 28 } }}>
        <div className="flex items-center gap-3 mb-6">
          <img src={logo} alt="" className="w-[42px] h-[42px]" />
          <div>
            <h1 className="text-lg text-[#1b2430] leading-tight">Status Admin</h1>
            <p className="text-xs text-[#666B72]">CCD System Status</p>
          </div>
        </div>
        {error && <Alert type="error" showIcon message={error} className="mb-4" />}
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item name="username" label="Username" rules={[{ required: true }]}><Input autoComplete="username" autoFocus /></Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>Sign in</Button>
        </Form>
      </Card>
    </div>
  );
}
