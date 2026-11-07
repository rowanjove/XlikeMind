import React from 'react';
import ReactDOM from 'react-dom/client';
import { prepareProfilePage } from './storage/profiles';
import './index.css';

const rootElement = document.getElementById('root');
if (rootElement) {
  void prepareProfilePage().then(() => import('./ui/Popup')).then(({ Popup }) => {
    ReactDOM.createRoot(rootElement).render(<React.StrictMode><Popup /></React.StrictMode>);
  }).catch(() => {
    const message = document.createElement('p');
    message.className = 'lm-popup-loading';
    message.setAttribute('role', 'alert');
    message.textContent = '无法打开本地档案。请重新打开弹窗。';
    rootElement.replaceChildren(message);
  });
}
