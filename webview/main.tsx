import { createRoot } from 'react-dom/client';
import * as React from 'react';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
