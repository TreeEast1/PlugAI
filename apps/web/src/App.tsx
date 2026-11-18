import React, { useEffect, useState } from 'react';
import { api } from './api';
import { initSocket, loadProjects, openProject, setState, toast, useStore } from './store';
import { Lab } from './lab/Lab';
import { AgentPanel } from './panels/AgentPanel';
import { Engineering } from './panels/Engineering';
import { Toolbar } from './Toolbar';
import { Link } from './router';

function Logo() {
  return (
    <Link to="/" className="logo">
      <svg width="28" height="28" viewBox="0 0 32 32">
        <rect width="32" height="32" rx="8" fill="#0f1a2c" />
        <path d="M11 6v6M21 6v6M8 12h16v5a8 8 0 0 1-16 0z" stroke="#37e2c4" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        <path d="M16 25v3" stroke="#37e2c4" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <div>
        <b>PlugAI</b>
        <small>Vibe Coding for the Physical World.</small>
      </div>
    </Link>
  );
}

function EnvPills() {
  const env = useStore((s) => s.env);
  const connected = useStore((s) => s.connected);
  if (!env) return null;
  const esp = env.toolchains.esp32;
  const avr = env.toolchains.avr;
  const ver = (arr: any[] | undefined, n: string) => arr?.find((v: any) => v.name.startsWith(n))?.version ?? '';
  return (
    <div className="env">
      <span className={`pill ${connected ? 'ok' : 'bad'}`}>{connected ? 'live link' : 'reconnecting…'}</span>
      <span className={`pill ${esp.ok ? 'ok' : 'bad'}`} title={esp.error ?? esp.versions?.map((v: any) => `${v.name} ${v.version}`).join('\n')}>ESP-IDF {ver(esp.versions, 'ESP-IDF')}</span>
      <span className={`pill ${esp.espEmuNative ? 'ok' : 'bad'}`} title="Espressif esp-emu (native for esptool flashing, WASM core for live simulation)">esp-emu {ver(esp.versions, 'esp-emu')?.replace('esp-emu ', '')}</span>
      <span className={`pill ${avr.ok ? 'ok' : 'bad'}`} title={avr.error ?? avr.versions?.map((v: any) => `${v.name} ${v.version}`).join('\n')}>arduino-cli · avr8js</span>
      <span className={`pill ${env.llm.configured ? 'ok' : 'bad'}`}>{env.llm.configured ? env.llm.model : 'no LLM key'}</span>
    </div>
  );
}

function NewProject({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('My hardware project');
  const [board, setBoard] = useState('esp32c3-devkitm-1');
  const [example, setExample] = useState('');
  const [examples, setExamples] = useState<any[]>([]);
  useEffect(() => {
    void api.get('/examples').then(setExamples);
  }, []);
  const create = async () => {
    try {
      const p = await api.post('/projects', { name, board, example: example || undefined });
      await loadProjects();
      await openProject(p.id);
      onClose();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New project</h3>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Board</label>
        <div className="board-pick">
          <button className={board === 'esp32c3-devkitm-1' ? 'on' : ''} onClick={() => setBoard('esp32c3-devkitm-1')}>
            <b>ESP32-C3-DevKitM-1</b>
            <small>RISC-V 160 MHz · ESP-IDF v5.5 · esp-emu · real esptool virtual flashing</small>
          </button>
          <button className={board === 'arduino-uno' ? 'on' : ''} onClick={() => setBoard('arduino-uno')}>
            <b>Arduino Uno R3</b>
            <small>ATmega328P 16 MHz · arduino-cli · avr8js · direct image load</small>
          </button>
        </div>
        <label>Start from</label>
        <select value={example} onChange={(e) => setExample(e.target.value)}>
          <option value="">Blank project (describe it to the AI)</option>
          {examples.filter((x) => x.boards.includes(board === 'arduino-uno' ? 'uno' : 'esp32c3')).map((x) => (
            <option key={x.id} value={x.id}>Hand-written example: {x.title}</option>
          ))}
        </select>
        {example && <div className="note">Examples are hand-written reference projects (manual mode). They are labelled as such and are never presented as AI output.</div>}
        <div className="row end">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={create}>Create</button>
        </div>
      </div>
    </div>
  );
}

function Toast() {
  const t = useStore((s) => s.toast);
  const [, force] = useState(0);
  useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => {
      setState({ toast: null });
      force((x) => x + 1);
    }, t.kind === 'error' ? 7000 : 3500);
    return () => clearTimeout(h);
  }, [t]);
  if (!t) return null;
  return <div className={`toast ${t.kind}`} onClick={() => setState({ toast: null })}>{t.text}</div>;
}

export function App() {
  const projects = useStore((s) => s.projects);
  const project = useStore((s) => s.project);
  const [showNew, setShowNew] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);
  useEffect(() => {
    initSocket();
    void (async () => {
      const [env, boards] = await Promise.all([api.get('/environment'), api.get('/boards')]);
      setState({ env, boards });
      const list = await loadProjects();
      const want = new URLSearchParams(location.search).get('project');
      const last = localStorage.getItem('plugai.project');
      const pick = list.find((p: any) => p.id === want) ?? list.find((p: any) => p.id === last) ?? list[0];
      if (pick) await openProject(pick.id);
      else setShowNew(true);
    })().catch((e) => toast('error', `Cannot reach PlugAI server: ${e.message}`));
  }, []);
  return (
    <div className={`app ${rightOpen ? '' : 'right-collapsed'}`}>
      <header>
        <Logo />
        <div className="project-picker">
          <select value={project?.meta.id ?? ''} onChange={(e) => void openProject(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.board === 'arduino-uno' ? 'Uno' : 'ESP32-C3'}{p.origin !== 'blank' ? ' · example' : ''}
              </option>
            ))}
          </select>
          <button className="ghost" onClick={() => setShowNew(true)}>+ New</button>
          {project && <span className="dim board-tag">{project.meta.board === 'arduino-uno' ? 'Arduino Uno · avr8js' : 'ESP32-C3-DevKitM-1 · esp-emu'}</span>}
        </div>
        <EnvPills />
        <button className="ghost" onClick={() => setRightOpen(!rightOpen)} title="Engineering panel">{rightOpen ? 'Hide' : 'Show'} engineering ⟩</button>
      </header>
      <main>
        <aside className="left"><AgentPanel /></aside>
        <section className="center"><Lab /></section>
        {rightOpen && <aside className="right">{project && <Engineering />}</aside>}
      </main>
      <footer><Toolbar /></footer>
      {showNew && <NewProject onClose={() => setShowNew(false)} />}
      <Toast />
    </div>
  );
}
