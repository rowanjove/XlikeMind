import React from 'react';
import ReactDOM from 'react-dom/client';
import { prepareProfilePage } from './storage/profiles';
import './index.css';

// Chrome often ignores a chrome-extension favicon URL. A data URL still shows in the tab.
function ensureExtensionFavicon() {
  const source =
    typeof chrome !== 'undefined' && chrome.runtime?.getURL
      ? chrome.runtime.getURL('icons/icon48.png')
      : 'icons/icon48.png';

  void fetch(source)
    .then((response) => (response.ok ? response.blob() : null))
    .then((blob) => {
      if (!blob) return;
      const reader = new FileReader();
      reader.onload = () => {
        const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
        if (!link || typeof reader.result !== 'string') return;
        link.type = blob.type || 'image/png';
        link.href = reader.result;
      };
      reader.readAsDataURL(blob);
    })
    .catch(() => {
      // The HTML already includes an inline icon.
    });
}

ensureExtensionFavicon();

const rootElement = document.getElementById('root');
if (rootElement) {
  void prepareProfilePage().then(() => import('./ui/App')).then(({ App }) => {
    ReactDOM.createRoot(rootElement).render(<React.StrictMode><App /></React.StrictMode>);
  }).catch(() => {
    rootElement.textContent = '无法打开本地档案。请重新加载扩展页面。';
  });
}
