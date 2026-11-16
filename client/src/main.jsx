import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { StyleProvider } from '@ant-design/cssinjs';
import App from './App';
import './index.css';
import { antdTheme } from './theme/antdTheme';

ReactDOM.createRoot(document.getElementById('root')).render(
  <StyleProvider hashPriority="high">
    <ConfigProvider theme={antdTheme}>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <App />
      </BrowserRouter>
    </ConfigProvider>
  </StyleProvider>,
);
