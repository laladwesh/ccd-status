import { Tag } from 'antd';
import { stateMeta } from '../constants';

export default function StatusTag({ state, short = false, style }) {
  const m = stateMeta(state);
  return <Tag color={m.color} style={{ marginInlineEnd: 0, ...style }}>{short ? m.short || m.label : m.label}</Tag>;
}
