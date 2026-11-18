import React, { useState } from 'react';
import { api } from './api';
import { refreshProject, setState, toast, useStore } from './store';

export function Toolbar() {
  const project = useStore((s) => s.project);
  const sim = useStore((s) => s.sim);
  const build = useStore((s) => s.build);
  const flash = useStore((s) => s.flash);
  const activeRun = useStore((s) => s.activeRun);
  const [busy, setBusy] = useState<string | null>(null);
  if (!project) return <div className="toolbar" />;
  const id = project.meta.id;
  const isEsp = project.meta.board === 'esp32c3-devkitm-1';
  const lb = project.lastBuild;
  const buildOk = lb?.status === 'success';
  const stale = buildOk && lb!.sourceHash !== project.sourceHash;
  const loaded = project.loaded;
  const loadedStale = loaded && lb && buildOk && loaded.buildId !== lb.buildId;
  const simLoaded = ['running', 'paused', 'loaded'].includes(sim.status);
  const locked = !!activeRun;

  const act = async (name: string, fn: () => Promise<any>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
      void refreshProject();
    }
  };
  const doBuild = () =>
    act('build', async () => {
      setState({ build: { running: true, log: '' } });
      const r = await api.post(`/projects/${id}/build`);
      toast(r.status === 'success' ? 'ok' : 'error', r.status === 'success' ? `Build ${r.buildId} succeeded` : `Build failed: ${r.error}`);
    });
  const doFlash = (method: string) =>
    act('flash', async () => {
      setState({ flash: { running: true, steps: [] } });
      const r = await api.post(`/projects/${id}/flash`, { method });
      toast(r.status === 'success' ? 'ok' : 'error', r.status === 'success' ? (r.method === 'esptool-virtual-uart' ? `Flashed ${r.bytesWritten} bytes via esptool (virtual UART), verified & booted` : 'Firmware image loaded into simulated flash') : `Flash failed: ${r.error}`);
    });
  const sim_ = (a: string) => act(a, () => api.post(`/projects/${id}/sim/${a}`));

  const why = {
    build: locked ? 'AI agent is running' : build.running ? 'Build in progress' : '',
    flash: locked ? 'AI agent is running' : !buildOk ? 'Needs a successful build' : stale ? 'Sources changed since last build — build first' : '',
    run: locked ? 'AI agent is running' : !loaded ? 'Flash / load firmware first' : sim.status === 'running' ? 'Already running' : '',
    pause: sim.status !== 'running' ? 'MCU not running' : '',
    reset: !simLoaded ? 'No firmware loaded in the simulator' : '',
    stop: !simLoaded ? 'Simulator not active' : '',
  };
  const artifacts = buildOk ? lb!.artifacts.filter((a) => ['elf', 'bin', 'hex', 'merged-bin'].includes(a.kind)) : [];
  return (
    <div className="toolbar">
      <div className="tb-group">
        <button className="tb primary" disabled={!!why.build || !!busy} title={why.build} onClick={doBuild}>
          {build.running || busy === 'build' ? <span className="spin" /> : '⚙'} Build
        </button>
        {isEsp ? (
          <>
            <button className="tb" disabled={!!why.flash || !!busy} title={why.flash || 'esptool ROM-loader protocol over a TCP-bridged virtual UART into emulated SPI flash'} onClick={() => doFlash('esptool-virtual-uart')}>
              {busy === 'flash' || flash.running ? <span className="spin" /> : '⚡'} Flash (esptool · virtual UART)
            </button>
            <button className="tb ghost" disabled={!!why.flash || !!busy} title={why.flash || 'Hand the merged image to the emulator directly (no serial protocol)'} onClick={() => doFlash('direct-image-load')}>
              Direct load
            </button>
          </>
        ) : (
          <button className="tb" disabled={!!why.flash || !!busy} title={why.flash || 'Parses the HEX into avr8js program memory (not a serial bootloader upload)'} onClick={() => doFlash('direct-image-load')}>
            {busy === 'flash' ? <span className="spin" /> : '⇩'} Load firmware into simulated flash
          </button>
        )}
      </div>
      <div className="tb-group">
        <button className="tb run" disabled={!!why.run || !!busy} title={why.run} onClick={() => sim_('start')}>▶ Run</button>
        <button className="tb" disabled={!!why.pause || !!busy} title={why.pause} onClick={() => sim_('pause')}>❚❚ Pause</button>
        <button className="tb" disabled={!!why.reset || !!busy} title={why.reset} onClick={() => sim_('reset')}>↺ Reset</button>
        <button className="tb" disabled={!!why.stop || !!busy} title={why.stop} onClick={() => sim_('stop')}>■ Stop</button>
      </div>
      <div className="tb-group">
        <select
          className="tb"
          disabled={!artifacts.length}
          title={artifacts.length ? 'Download firmware artifact' : 'Needs a successful build'}
          value=""
          onChange={(e) => {
            if (e.target.value) window.location.href = `/api/projects/${id}/builds/${lb!.buildId}/artifacts/${e.target.value}`;
          }}
        >
          <option value="">⤓ Download firmware</option>
          {artifacts.map((a) => (
            <option key={a.name} value={a.name}>{a.name} ({(a.size / 1024).toFixed(1)} KB)</option>
          ))}
        </select>
      </div>
      <div className="tb-status">
        {lb && <span className={`status ${lb.status}`}>build {lb.status}</span>}
        {stale && <span className="warn-inline">sources changed → rebuild</span>}
        {loaded && <span className="dim">loaded {loaded.buildId}</span>}
        {loadedStale && <span className="warn-inline">running firmware is older than the latest build</span>}
        {project.lastVerification && (
          <span className={`status ${project.lastVerification.passed ? 'success' : 'failed'}`} title="Virtual simulation only — never a physical hardware test">
            {project.lastVerification.passed ? '虚拟验证通过' : '虚拟验证未通过'}
          </span>
        )}
        <span className="dim">实体硬件：未连接</span>
      </div>
    </div>
  );
}
