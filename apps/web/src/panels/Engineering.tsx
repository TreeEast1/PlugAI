import React, { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { cpp } from '@codemirror/lang-cpp';
import { tokyoNight } from '@uiw/codemirror-theme-tokyo-night';
import { api } from '../api';
import { refreshProject, toast, useStore } from '../store';
import { Signals } from './Signals';

const TABS = ['Code', 'Build', 'Serial', 'Signals', 'Debug', 'History'] as const;
type Tab = (typeof TABS)[number];

export function Engineering() {
  const [tab, setTab] = useState<Tab>('Code');
  const build = useStore((s) => s.build);
  const sim = useStore((s) => s.sim);
  const ver = useStore((s) => s.project?.lastVerification);
  return (
    <div className="eng">
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t}
            {t === 'Build' && build.running && <span className="spin" />}
            {t === 'Serial' && sim.status === 'running' && <span className="pulse" />}
            {t === 'Debug' && ver && <span className={`mini-badge ${ver.passed ? 'ok' : 'bad'}`}>{ver.passed ? '✓' : '✗'}</span>}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {tab === 'Code' && <CodeTab />}
        {tab === 'Build' && <BuildTab />}
        {tab === 'Serial' && <SerialTab />}
        {tab === 'Signals' && <Signals />}
        {tab === 'Debug' && <DebugTab />}
        {tab === 'History' && <HistoryTab />}
      </div>
    </div>
  );
}

function CodeTab() {
  const project = useStore((s) => s.project)!;
  const fileVersion = useStore((s) => s.fileVersion);
  const files = project.files;
  const def = files.find((f) => /main\.c$|sketch\.ino$/.test(f.path))?.path ?? files[0]?.path;
  const [path, setPath] = useState(def);
  const [orig, setOrig] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const editable = files.find((f) => f.path === path)?.editable ?? false;
  const dirty = text !== orig;
  useEffect(() => {
    if (!files.some((f) => f.path === path)) setPath(def);
  }, [files, path, def]);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const lastPath = useRef<string | undefined>(undefined);
  const [external, setExternal] = useState(false);
  useEffect(() => {
    if (!path) return;
    let cancel = false;
    const switched = lastPath.current !== path;
    lastPath.current = path;
    api.get(`/projects/${project.meta.id}/file/${path}`).then((r) => {
      if (cancel) return;
      if (switched || !dirtyRef.current) {
        setText(r.content);
        setExternal(false);
      } else if (r.content !== orig) setExternal(true);
      setOrig(r.content);
    });
    return () => {
      cancel = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, project.meta.id, fileVersion, project.head]);
  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/projects/${project.meta.id}/file/${path}`, { content: text, message: `user edit: ${path}` });
      setOrig(text);
      toast('ok', `Saved ${path} (committed). Build to apply.`);
      void refreshProject();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="code-tab">
      <div className="file-bar">
        <select value={path} onChange={(e) => setPath(e.target.value)}>
          {files.map((f) => (
            <option key={f.path} value={f.path}>
              {f.path} {f.editable ? '' : '(managed)'}
            </option>
          ))}
        </select>
        <span className="dim">{editable ? (dirty ? 'modified' : 'saved') : 'platform-managed, read-only'}</span>
        {external && <span className="warn-inline" title="Another writer (e.g. the AI agent) changed this file">changed on server — <a onClick={() => { setText(orig); setExternal(false); }}>reload</a></span>}
        <button className="primary sm" disabled={!editable || !dirty || saving} onClick={save} title={!editable ? 'This file is managed by PlugAI' : ''}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <CodeMirror
        value={text}
        height="100%"
        theme={tokyoNight}
        extensions={[cpp()]}
        editable={editable}
        onChange={(v) => setText(v)}
        basicSetup={{ foldGutter: false }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            if (editable && dirty) void save();
          }
        }}
      />
    </div>
  );
}

function BuildTab() {
  const project = useStore((s) => s.project)!;
  const build = useStore((s) => s.build);
  const lb = project.lastBuild;
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [build.log]);
  const [history, setHistory] = useState<any[]>([]);
  useEffect(() => {
    void api.get(`/projects/${project.meta.id}/builds`).then(setHistory);
  }, [project.meta.id, lb?.buildId]);
  return (
    <div className="build-tab">
      {lb && (
        <div className={`build-card ${lb.status}`}>
          <div className="row">
            <b>{lb.buildId}</b>
            <span className={`status ${lb.status}`}>{lb.status.toUpperCase()}</span>
            <span className="dim">{lb.durationMs ? `${(lb.durationMs / 1000).toFixed(1)} s` : ''}</span>
            <span className="dim">commit {lb.sourceCommit?.slice(0, 8)}</span>
          </div>
          {lb.error && <div className="err-line">{lb.error}</div>}
          {lb.diagnostics.filter((d) => d.severity !== 'note').length > 0 && (
            <div className="diags">
              {lb.diagnostics.filter((d) => d.severity !== 'note').slice(0, 30).map((d, i) => (
                <div key={i} className={`diag ${d.severity}`}>
                  <code>{d.file}:{d.line}{d.column ? `:${d.column}` : ''}</code> <b>{d.severity}</b> {d.message}
                </div>
              ))}
            </div>
          )}
          {lb.artifacts.length > 0 && (
            <table className="artifacts">
              <thead>
                <tr><th>Artifact</th><th>Size</th><th>SHA-256</th><th>Offset</th><th /></tr>
              </thead>
              <tbody>
                {lb.artifacts.map((a) => (
                  <tr key={a.name}>
                    <td>{a.name}</td>
                    <td>{a.size.toLocaleString()} B</td>
                    <td><code title={a.sha256}>{a.sha256.slice(0, 16)}…</code></td>
                    <td>{a.flashOffset !== undefined ? `0x${a.flashOffset.toString(16)}` : ''}</td>
                    <td><a href={`/api/projects/${project.meta.id}/builds/${lb.buildId}/artifacts/${a.name}`}>download</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <details>
            <summary>Commands & toolchain</summary>
            {lb.commands.map((c, i) => <pre key={i} className="cmd">{c.join(' ')}</pre>)}
            {lb.toolVersions.map((t) => <div key={t.name} className="kv"><span>{t.name}</span><code>{t.version}</code></div>)}
          </details>
        </div>
      )}
      <div className="log-head">Build log {build.running && <span className="spin" />}</div>
      <pre ref={logRef} className="log">{build.log || 'No build yet. Press Build in the toolbar (or ask the AI).'}</pre>
      <details className="hist">
        <summary>Build history ({history.length})</summary>
        {history.map((b) => (
          <div key={b.buildId} className="kv"><span className={`status ${b.status}`}>{b.status}</span><code>{b.buildId}</code><small>{b.error ?? ''}</small></div>
        ))}
      </details>
    </div>
  );
}

function SerialTab() {
  const uart = useStore((s) => s.uart);
  const sim = useStore((s) => s.sim);
  const project = useStore((s) => s.project)!;
  const [line, setLine] = useState('');
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [uart, follow]);
  const send = async () => {
    try {
      await api.post(`/projects/${project.meta.id}/sim/uart`, { text: line + '\n' });
      setLine('');
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  return (
    <div className="serial-tab">
      <div className="note">UART0 bytes produced by the emulated UART peripheral. Text here is never used as proof of GPIO behaviour.</div>
      <pre ref={ref} className="terminal">{uart || (sim.status === 'idle' ? 'Load firmware and press Run to see the MCU console.' : '')}</pre>
      <div className="serial-input">
        <input value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} placeholder={sim.status === 'running' ? 'Send to UART RX…' : 'MCU not running'} disabled={sim.status !== 'running'} />
        <label className="dim"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
      </div>
    </div>
  );
}

function DebugTab() {
  const project = useStore((s) => s.project)!;
  const sim = useStore((s) => s.sim);
  const flash = useStore((s) => s.flash);
  const [vers, setVers] = useState<any[]>([]);
  useEffect(() => {
    void api.get(`/projects/${project.meta.id}/verifications`).then(setVers);
  }, [project.meta.id, project.lastVerification?.verificationId]);
  const lastFlash = flash.last ?? project.flashes[0];
  const warnings = sim.warnings.length ? sim.warnings : project.solution.warnings;
  return (
    <div className="debug-tab">
      <section>
        <h4>MCU</h4>
        <div className="kv"><span>Status</span><b>{sim.status}</b></div>
        {sim.info && <div className="kv"><span>Backend</span><small>{sim.info.name} v{sim.info.version} · {sim.info.license}</small></div>}
        {sim.clock && <div className="kv"><span>Clock</span><small>{(sim.clock.simUs / 1000).toFixed(1)} ms simulated · {sim.clock.cycles.toLocaleString()} cycles · {(sim.clock.wallMs / 1000).toFixed(1)} s wall · ×{sim.clock.speed?.toFixed(2)}</small></div>}
        {project.loaded && <div className="kv"><span>Firmware</span><small>{project.loaded.buildId} · sha256 {project.loaded.sha256.slice(0, 12)}… · {project.loaded.method}</small></div>}
        {sim.error && <div className="err-line">{sim.error}</div>}
        {sim.pins.filter((p) => p.output || p.pull !== 'none').length > 0 && (
          <div className="pins-grid">
            {sim.pins.filter((p) => p.output || p.pull !== 'none').map((p) => (
              <span key={p.pin} className={`pin-chip ${p.output ? (p.level ? 'hi' : 'lo') : 'in'}`}>{p.pin} {p.output ? (p.driver === 'peripheral' ? `periph#${p.signal}` : p.level ? 'OUT 1' : 'OUT 0') : `IN ${p.pull}`}</span>
            ))}
          </div>
        )}
      </section>
      <section>
        <h4>Circuit warnings</h4>
        {warnings.length === 0 ? <div className="dim">None</div> : warnings.map((w: any, i: number) => <div key={i} className={`warn ${w.severity}`}><b>{w.code}</b> {w.message}</div>)}
      </section>
      <section>
        <h4>Last flash / load</h4>
        {flash.running && flash.steps.map((s) => <div key={s.step} className="kv"><span>{s.step}</span><b className={s.status}>{s.status}</b><small>{s.detail}</small></div>)}
        {lastFlash ? (
          <div>
            <div className="kv"><span>Method</span><b>{lastFlash.method === 'esptool-virtual-uart' ? 'Real virtual serial flashing (esptool ROM protocol)' : 'Direct image load (no serial protocol)'}</b></div>
            <div className="dim">{lastFlash.description}</div>
            {lastFlash.steps.map((s) => <div key={s.name} className="kv"><span>{s.name}</span><b className={s.status}>{s.status}</b><small>{s.detail}</small></div>)}
            {lastFlash.esptoolVersion && <div className="kv"><span>esptool</span><code>{lastFlash.esptoolVersion} · {lastFlash.transport}</code></div>}
            {lastFlash.flashImageBefore && <div className="kv"><span>Flash before</span><code>{lastFlash.flashImageBefore.sha256.slice(0, 16)}…</code></div>}
            {lastFlash.flashImageAfter && <div className="kv"><span>Flash after</span><code>{lastFlash.flashImageAfter.sha256.slice(0, 16)}…</code></div>}
            {lastFlash.bootEvidence && <div className="ok-line">{lastFlash.bootEvidence}</div>}
            {lastFlash.error && <div className="err-line">{lastFlash.error}</div>}
          </div>
        ) : <div className="dim">Nothing flashed yet.</div>}
      </section>
      <section>
        <h4>Verification reports (virtual)</h4>
        {vers.length === 0 && <div className="dim">No verification yet.</div>}
        {vers.map((v) => (
          <details key={v.verificationId} open={v === vers[0]}>
            <summary>
              <span className={`status ${v.passed ? 'success' : 'failed'}`}>{v.passed ? 'VIRTUAL PASS' : 'FAIL'}</span> {v.scenario.name} · {v.verificationId} · {v.simulatedMs.toFixed(0)} ms sim · fw {v.firmwareSha256?.slice(0, 10)}
            </summary>
            {v.results.map((r: any, i: number) => (
              <div key={i} className={`check ${r.passed ? 'pass' : 'fail'}`}>
                {r.passed ? '✓' : '✗'} <code>{r.check.type}</code>{r.logOnly && <em> (log only)</em>} {r.detail}
              </div>
            ))}
            {v.displayEvidence?.length > 0 && (
              <div className="evidence">
                {v.displayEvidence.map((d: any) => (
                  <figure key={d.png}>
                    <img src={`/api/projects/${project.meta.id}/traces/${d.png.split('/').pop()}`} alt={`${d.component} at ${d.atMs} ms`} />
                    <figcaption>{d.component} @ {d.atMs} ms (captured from controller frame memory)</figcaption>
                  </figure>
                ))}
              </div>
            )}
            {v.warnings.map((w: string, i: number) => <div key={i} className="warn warning">{w}</div>)}
            <div className="dim">Scope: virtual simulation only — not a physical hardware test.</div>
          </details>
        ))}
      </section>
    </div>
  );
}

function HistoryTab() {
  const project = useStore((s) => s.project)!;
  const [hist, setHist] = useState<any[]>([]);
  const [diff, setDiff] = useState<{ commit: string; text: string } | null>(null);
  useEffect(() => {
    void api.get(`/projects/${project.meta.id}/history`).then(setHist);
  }, [project.meta.id, project.head]);
  const restore = async (c: string) => {
    if (!confirm(`Restore firmware + circuit to ${c.slice(0, 8)}? (a new commit is created; nothing is lost)`)) return;
    try {
      await api.post(`/projects/${project.meta.id}/restore`, { commit: c });
      toast('ok', `Restored to ${c.slice(0, 8)} — rebuild to run it`);
      void refreshProject();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };
  return (
    <div className="history-tab">
      {hist.map((h) => (
        <div key={h.commit} className={`commit ${h.commit === project.head ? 'head' : ''}`}>
          <div className="row">
            <code>{h.commit.slice(0, 8)}</code>
            <span className="msg">{h.message}</span>
          </div>
          <div className="row dim">
            <small>{new Date(h.date).toLocaleString()}</small>
            <small>{h.files.join(', ')}</small>
            <button className="ghost sm" onClick={async () => setDiff({ commit: h.commit, text: (await api.get(`/projects/${project.meta.id}/history/${h.commit}`)).diff })}>diff</button>
            {h.commit !== project.head && <button className="ghost sm" onClick={() => void restore(h.commit)}>restore</button>}
          </div>
        </div>
      ))}
      {diff && (
        <div className="modal-bg" onClick={() => setDiff(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="insp-head"><b>{diff.commit.slice(0, 8)}</b><button className="ghost" onClick={() => setDiff(null)}>×</button></div>
            <pre className="log diff">{diff.text}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
