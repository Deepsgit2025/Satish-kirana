import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';

/**
 * Mounts the renderer.
 *
 * The root element is asserted rather than defaulted: it is in `index.html`
 * beside this file, so its absence is a broken build rather than a state to
 * handle, and failing loudly here beats a blank window with nothing in the
 * console.
 */
const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
