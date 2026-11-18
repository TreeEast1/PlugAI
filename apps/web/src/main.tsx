import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import { App } from './App';
import { fromUrl, usePath } from './router';
import { Landing } from './site/Landing';
import { CaseDetail, CasesPage, Film } from './site/CaseDetail';
import { isStaticSite } from './site/data';
import './styles.css';
import './site/site.css';

function Root() {
  const raw = usePath().split('?')[0];
  const path = fromUrl(raw).replace(/\/+$/, '') || '/';
  const m = path.match(/^\/cases\/([a-z0-9-]+)(\/film)?\/?$/);
  if (m) return m[2] ? <Film id={m[1]} /> : <CaseDetail id={m[1]} />;
  if (path.startsWith('/cases')) return <CasesPage />;
  if (path.startsWith('/studio') && !isStaticSite) return <App />;
  return <Landing />;
}

createRoot(document.getElementById('root')!).render(<Root />);
