import React, { useEffect, useMemo, useState } from 'react';
import { Link, navigate } from '../router';
import { api } from '../api';
import { CircuitView, usePlayback } from './CircuitView';
import { CaseCard, SiteFooter, SiteNav } from './Landing';
import { REPO_URL, assetBase, isStaticSite, keySteps, money, useCase, useCases, useReveal } from './data';

export function CasesPage() {
  const cases = useCases();
  useReveal(cases);
  return (
    <div className="site">
      <SiteNav />
      <div className="wrap gallery-page">
        <div className="kicker">Cases</div>
        <h2>案例库</h2>
        <p className="sub">全部来自真实 DeepSeek 运行与真实工具链：Prompt、规划、固件、编译哈希、验证结果和仿真回放都可以审阅；点击 Fork，在案例基础上继续优化。</p>
        <div className="grid" style={{ marginTop: 36 }}>
          {(cases ?? []).map((c) => (
            <CaseCard key={c.id} c={c} />
          ))}
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}

const roleCn: Record<string, string> = { planner: 'planner', coder: 'coder', debugger: 'debugger', executor: 'executor' };

function Turn({ t, i }: { t: any; i: number }) {
  const [all, setAll] = useState(false);
  const tl = t.timeline.filter((e: any) => ['llm', 'tool', 'build', 'flash', 'verify'].includes(e.kind));
  return (
    <div className="turn">
      <div className="q">
        <b style={{ color: '#7fd8ff', marginRight: 8 }}>#{i + 1}</b>
        {t.prompt}
      </div>
      <div className="tm">
        <span className={t.status === 'success' ? '' : ''} style={{ color: t.status === 'success' ? '#8ff0c9' : '#ffd27a' }}>
          {t.status === 'success' ? '✓ 虚拟验证通过' : '✗ 未通过 / 能力边界'}
        </span>
        <span>
          <b>{t.wallSec}</b> s
        </span>
        <span>
          <b>{t.metrics.llmCalls}</b> 次 DeepSeek 调用
        </span>
        <span>
          <b>{t.metrics.toolCalls}</b> 次工具调用
        </span>
        <span>
          <b>{(t.metrics.promptTokens + t.metrics.completionTokens).toLocaleString()}</b> tok
        </span>
        <span>
          <b>{money(t.metrics.costUsd ?? 0)}</b>
        </span>
        {t.metrics.repairRounds > 0 && (
          <span>
            修复 <b>{t.metrics.repairRounds}</b> 轮
          </span>
        )}
      </div>
      {t.plan && (
        <>
          <h6>AI 规划 · {t.plan.change_type}</h6>
          <div className="plan">{t.plan.understanding}</div>
          {t.plan.pin_plan?.length > 0 && (
            <div className="plan" style={{ marginTop: 6 }}>
              {t.plan.pin_plan.map((p: any) => (
                <span key={p.board_pin + p.signal} className="chip-s" style={{ marginRight: 6, display: 'inline-block', marginTop: 4 }}>
                  {p.board_pin} · {p.signal}
                </span>
              ))}
            </div>
          )}
          {t.plan.capability_gaps?.length > 0 && (
            <div className="plan" style={{ color: '#ffd27a', marginTop: 6 }}>
              能力缺口：{t.plan.capability_gaps.join('；')}
            </div>
          )}
        </>
      )}
      <h6>执行过程（真实事件日志）</h6>
      <div className="tl">
        {(all ? tl : tl.slice(0, 14)).map((e: any, k: number) => (
          <div key={k}>
            <span className="mono">+{(e.t / 1000).toFixed(1)}s</span>
            <span className={`r ${e.role ?? 'executor'}`}>{e.kind === 'llm' ? `${roleCn[e.role]} LLM` : e.kind === 'tool' ? roleCn[e.role] : e.kind}</span>
            <span className="x">
              {e.kind === 'llm'
                ? `${(e.ms / 1000).toFixed(1)} s · ${e.tokens.toLocaleString()} tok${e.tools.length ? ` → ${e.tools.join(', ')}` : ''}`
                : e.kind === 'tool'
                  ? `${e.name}${e.ok ? '' : ' ✗'} · ${e.preview}`
                  : e.kind === 'build'
                    ? `${e.status} · ${(e.ms / 1000).toFixed(1)} s${e.error ? ` · ${e.error}` : ''}`
                    : e.kind === 'flash'
                      ? `${e.method} · ${e.status}${e.bytes ? ` · ${e.bytes.toLocaleString()} B` : ''}`
                      : `${e.passed ? 'PASSED' : 'FAILED'} · ${e.results.length} checks`}
            </span>
          </div>
        ))}
        {tl.length > 14 && (
          <a style={{ color: '#37e2c4', cursor: 'pointer', fontSize: 12 }} onClick={() => setAll(!all)}>
            {all ? '收起' : `展开全部 ${tl.length} 条`}
          </a>
        )}
      </div>
      {t.verification && (
        <>
          <h6>验证结果（{t.verification.simulatedMs?.toFixed(0)} ms 仿真 · 固件 {t.verification.firmwareSha256?.slice(0, 10)}）</h6>
          <div className="checks">
            {t.verification.results.map((r: any, k: number) => (
              <div key={k} className={r.logOnly ? 'l' : r.passed ? '' : 'f'}>
                {r.passed ? '✓' : '✗'} {r.detail}
              </div>
            ))}
          </div>
        </>
      )}
      {t.summary && (
        <>
          <h6>AI 交付说明</h6>
          <div className="summary">{t.summary.split('\n\n虚拟验证通过')[0]}</div>
        </>
      )}
    </div>
  );
}

export function CaseDetail({ id }: { id: string }) {
  const kase = useCase(id);
  const [tab, setTab] = useState<'process' | 'code' | 'evidence'>('process');
  const [forking, setForking] = useState(false);
  const pb = usePlayback(kase?.replay?.durationMs ?? 0, { autoplay: true, loop: true });
  useReveal(kase);
  const files = useMemo(() => Object.entries<string>(kase?.final.files ?? {}), [kase]);
  const [file, setFile] = useState(0);
  useEffect(() => setFile(0), [id]);
  if (!kase)
    return (
      <div className="site">
        <SiteNav />
      </div>
    );
  const base = assetBase(id);
  const tot = kase.totals;
  const fork = async () => {
    if (isStaticSite) {
      if (REPO_URL) window.open(REPO_URL, '_blank', 'noopener');
      return;
    }
    setForking(true);
    const p = await api.post(`/cases/${id}/fork`);
    navigate(`/studio?project=${p.id}`);
  };
  const evidence = kase.turns.flatMap((t: any) => t.verification?.evidence ?? []);
  return (
    <div className="site">
      <SiteNav />
      <div className="wrap">
        <div className="crumbs">
          <Link to="/">首页</Link> / <Link to="/cases">案例</Link> / {kase.title}
        </div>
        <div className="case-head">
          <div>
            <span className={`vbadge ${kase.kind === 'boundary' ? 'warn' : ''}`}>{kase.kind === 'boundary' ? '诚实的能力边界 · 未伪造结果' : '✓ 虚拟验证通过（非实体硬件）'}</span>
            <h1>{kase.title}</h1>
            <p className="sub">{kase.subtitle}</p>
            <div className="meta" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
              <span className="chip-s">{kase.boardName}</span>
              {kase.tags.map((t: string) => (
                <span key={t} className="chip-s">
                  {t}
                </span>
              ))}
            </div>
          </div>
          {kase.kind !== 'boundary' && (
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn primary" onClick={fork} disabled={forking}>
                {forking ? '正在创建…' : isStaticSite ? '在本地 Fork 这个案例' : 'Fork 到工作台继续优化'} <span className="arrow">→</span>
              </button>
            </div>
          )}
        </div>
        <div className="kpis">
          <div>
            <div className="v">{kase.turns.length}</div>
            <div className="l">对话轮次</div>
          </div>
          <div>
            <div className="v">{Math.round(tot.wallSec)} s</div>
            <div className="l">总耗时（含编译/烧录/验证）</div>
          </div>
          <div>
            <div className="v">{tot.llmCalls}</div>
            <div className="l">DeepSeek 调用</div>
          </div>
          <div>
            <div className="v">{tot.toolCalls}</div>
            <div className="l">工具调用</div>
          </div>
          <div>
            <div className="v">{(tot.tokens / 1000).toFixed(0)}k</div>
            <div className="l">Token</div>
          </div>
          <div>
            <div className="v">{money(tot.costUsd)}</div>
            <div className="l">API 成本</div>
          </div>
        </div>
        <div className="case-grid">
          <div className="player">
            {kase.replay ? (
              <>
                <div className="scene">
                  <CircuitView kase={kase} t={pb.t} assetBase={base} />
                </div>
                <div className="ctrl">
                  <button onClick={() => pb.setPlaying(!pb.playing)}>{pb.playing ? '❚❚' : '▶'}</button>
                  <input type="range" min={0} max={kase.replay.durationMs} value={pb.t} onChange={(e) => pb.setT(Number(e.target.value))} />
                  <span className="mono">
                    {(pb.t / 1000).toFixed(2)} / {(kase.replay.durationMs / 1000).toFixed(1)} s
                  </span>
                  <select value={pb.speed} onChange={(e) => pb.setSpeed(Number(e.target.value))}>
                    {[0.25, 0.5, 1, 2, 4].map((s) => (
                      <option key={s} value={s}>
                        ×{s}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="note">回放：最终固件在 {kase.final.build ? `构建 ${kase.final.build.buildId}` : ''} 上的仿真器真实记录（GPIO 边沿、电路求解出的灯光状态{kase.replay.frames.length ? '、LCD 帧存截图' : ''}），时间轴为仿真时间。</div>
              </>
            ) : kase.hasVideo ? (
              <video src={`${base}/video.webm`} autoPlay muted loop playsInline />
            ) : (
              <div className="scene" style={{ display: 'grid', placeItems: 'center', color: '#8592a8', padding: 40, textAlign: 'center', lineHeight: 1.7 }}>
                该需求超出平台可仿真的能力，AI 没有修改工程、没有编译，也没有生成任何「成功」画面。
                <br />
                这本身就是我们想展示的：不伪造。
              </div>
            )}
          </div>
          <div className="panel">
            <div className="ptabs">
              <button className={tab === 'process' ? 'on' : ''} onClick={() => setTab('process')}>
                对话与过程
              </button>
              <button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>
                固件代码
              </button>
              <button className={tab === 'evidence' ? 'on' : ''} onClick={() => setTab('evidence')}>
                构建与证据
              </button>
            </div>
            <div className="pbody">
              {tab === 'process' && kase.turns.map((t: any, i: number) => <Turn key={t.runId} t={t} i={i} />)}
              {tab === 'code' && (
                <>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                    {files.map(([p], i) => (
                      <button key={p} className={`btn sm ${i === file ? 'primary' : ''}`} onClick={() => setFile(i)}>
                        {p}
                      </button>
                    ))}
                  </div>
                  <pre className="codebox">{files[file]?.[1] ?? '（无）'}</pre>
                  <p className="sub" style={{ fontSize: 12.5 }}>
                    这段代码逐字来自 DeepSeek 的 write_firmware 工具调用参数，并经真实编译器构建。
                  </p>
                </>
              )}
              {tab === 'evidence' && (
                <>
                  {kase.final.build && (
                    <>
                      <h6 style={{ fontSize: 12, color: '#5d6a80', textTransform: 'uppercase', letterSpacing: '0.08em' }}>构建产物 · {kase.final.build.buildId}</h6>
                      <table className="art">
                        <tbody>
                          {kase.final.build.artifacts.map((a: any) => (
                            <tr key={a.name}>
                              <td>{a.name}</td>
                              <td>{a.size.toLocaleString()} B</td>
                              <td className="mono">{a.sha256.slice(0, 24)}…</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="plan" style={{ marginTop: 10, fontSize: 12.5, color: '#8592a8' }}>
                        {kase.final.build.toolVersions.map((v: any) => `${v.name} ${v.version}`).join(' · ')}
                      </div>
                    </>
                  )}
                  {evidence.length > 0 && (
                    <>
                      <h6 style={{ fontSize: 12, color: '#5d6a80', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 18 }}>LCD 帧存截图（验证引擎捕获）</h6>
                      <div className="evid">
                        {evidence.map((e: any) => (
                          <figure key={e.file}>
                            <img src={`${base}/${e.file}`} alt="" />
                            <figcaption>
                              {e.component} @ {e.atMs} ms
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                    </>
                  )}
                  {kase.replay?.uart && (
                    <>
                      <h6 style={{ fontSize: 12, color: '#5d6a80', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 18 }}>UART 输出（仅日志，不作为物理证据）</h6>
                      <pre className="codebox" style={{ maxHeight: 220 }}>
                        {kase.replay.uart.split('\n').filter((l: string) => !/^\s*$/.test(l)).slice(-30).join('\n')}
                      </pre>
                    </>
                  )}
                  <p className="sub" style={{ fontSize: 12.5, marginTop: 14 }}>
                    原始运行日志：{kase.turns.map((t: any) => (
                      <a key={t.runId} href={`${base}/runs/${t.runId}/events.jsonl`} style={{ color: '#37e2c4', marginRight: 10 }}>
                        {t.runId}
                      </a>
                    ))}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}

/** 1280×720 scripted replay used to record the case videos (all content from the recorded run). */
export function Film({ id }: { id: string }) {
  const kase = useCase(id);
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!kase) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      setMs(performance.now() - t0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    (window as any).__filmReady = true;
    return () => cancelAnimationFrame(raf);
  }, [kase]);
  if (!kase) return <div className="film" />;
  const turn = kase.turns[kase.turns.length > 1 ? 0 : 0];
  const prompt = turn.prompt as string;
  const typed = prompt.slice(0, Math.floor(Math.min(1, ms / 1600) * prompt.length));
  const steps = keySteps(turn).slice(0, 9);
  const shown = Math.max(0, Math.min(steps.length, Math.floor((ms - 1800) / 380)));
  const code = Object.values<string>(kase.final.files)[0] ?? '';
  const codeLines = code.split('\n');
  const codeShown = codeLines.slice(0, Math.max(0, Math.floor((ms - 2200) / 40)));
  const simT = Math.max(0, ms - 5200) % Math.max(1, kase.replay?.durationMs ?? 1);
  const checks = (kase.turns[kase.turns.length - 1].verification?.results ?? []).filter((r: any) => !r.logOnly);
  const checksShown = Math.max(0, Math.min(checks.length, Math.floor((ms - 9000) / 600)));
  return (
    <div className="film">
      <div className="glow" style={{ width: 600, height: 600, background: '#1a7d6f', left: -200, top: -260 }} />
      <div className="glow" style={{ width: 520, height: 520, background: '#3a2c8f', right: -160, top: -200 }} />
      <div className="head">
        <svg width="34" height="34" viewBox="0 0 32 32">
          <rect width="32" height="32" rx="9" fill="#0d1626" stroke="#1f3049" />
          <path d="M11 6v6M21 6v6M8 12h16v5a8 8 0 0 1-16 0z" stroke="#37e2c4" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M16 25v3" stroke="#37e2c4" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <span className="t">{kase.title}</span>
        <span className="b">{kase.boardName}</span>
        <span className="b" style={{ marginLeft: 'auto', color: kase.kind === 'boundary' ? '#ffd27a' : '#8ff0c9' }}>{kase.kind === 'boundary' ? '能力边界 · 未伪造' : '虚拟验证通过'}</span>
      </div>
      <div className="left">
        <div className="q">
          {typed}
          {typed.length < prompt.length && <span className="caret" />}
        </div>
        <div className="steps">
          {steps.slice(0, shown).map((s, i) => (
            <div key={i} className={s.kind}>
              <i />
              <span>{s.text.length > 58 ? s.text.slice(0, 58) + '…' : s.text}</span>
            </div>
          ))}
        </div>
        <div className="code" style={{ opacity: ms > 2200 ? 1 : 0 }}>
          {codeShown.slice(-14).join('\n')}
        </div>
      </div>
      <div className="stage">
        {kase.replay ? <CircuitView kase={kase} t={simT} assetBase={assetBase(id)} /> : <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 18, height: '100%', padding: '0 34px', color: '#aeb9cb', fontSize: 16, lineHeight: 1.6 }}><div style={{ color: '#ffd27a', fontSize: 14, letterSpacing: '0.08em' }}>AI 判断：当前平台无法真实实现 —— 未修改工程、未编译、未伪造结果</div>{turn.plan?.capability_gaps?.slice(0, 3).map((g: string) => <div key={g}>✗ {g.length > 96 ? g.slice(0, 96) + '…' : g}</div>)}</div>}
        <div className="checks">
          {checks.slice(0, checksShown).slice(-3).map((c: any, i: number) => (
            <div key={i}>✓ {c.detail.length > 110 ? c.detail.slice(0, 110) + '…' : c.detail}</div>
          ))}
        </div>
      </div>
      <div className="foot">
        <span>
          <b>PlugAI</b> · recorded run replay — prompt, steps, code and signals from the real run log
        </span>
        <span>
          {kase.totals.llmCalls} DeepSeek calls · {Math.round(kase.totals.wallSec)} s · {money(kase.totals.costUsd)}
        </span>
      </div>
    </div>
  );
}
