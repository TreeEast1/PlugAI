import React, { useEffect, useMemo, useState } from 'react';
import { Link, navigate } from '../router';
import { CircuitView, usePlayback } from './CircuitView';
import { REPO_URL, assetBase, isStaticSite, keySteps, money, useCase, useCases, useProof, useReveal, type CaseSummary } from './data';
import { api } from '../api';

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#43f0d2" />
          <stop offset="1" stopColor="#5b8cff" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="#0d1626" stroke="#1f3049" />
      <path d="M11 6v6M21 6v6M8 12h16v5a8 8 0 0 1-16 0z" stroke="url(#lg)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <path d="M16 25v3" stroke="url(#lg)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** The studio runs compilers and emulators, so a public static site links to the source instead. */
function StudioLink({ small, label }: { small?: boolean; label: string }) {
  const cls = `btn primary${small ? ' sm' : ''}`;
  if (!isStaticSite) {
    return (
      <Link to="/studio" className={cls}>
        {label} <span className="arrow">→</span>
      </Link>
    );
  }
  if (REPO_URL) {
    return (
      <a className={cls} href={REPO_URL} target="_blank" rel="noreferrer">
        源码与本地运行 <span className="arrow">→</span>
      </a>
    );
  }
  return (
    <span className={cls} title="工作台需要本机的编译器和仿真器，请在自己的电脑上运行 npm run dev">
      工作台需本地运行
    </span>
  );
}

export function SiteNav() {
  return (
    <div className="nav">
      <div className="wrap">
        <Link to="/" className="brand">
          <Logo />
          <div>
            PlugAI
            <small>Vibe Coding for the Physical World</small>
          </div>
        </Link>
        <nav>
          <Link to="/#how">工作原理</Link>
          <Link to="/#real">真实性</Link>
          <Link to="/cases">案例</Link>
          <Link to="/#agents">AI Agent</Link>
          <Link to="/#hardware">支持硬件</Link>
        </nav>
        <div className="cta">
          <StudioLink small label="进入工作台" />
        </div>
      </div>
    </div>
  );
}

const HERO_CASES = ['pikachu-lcd', 'traffic-light', 'lcd-pet', 'esp32-blink-iteration'];

function HeroWindow() {
  const [idx, setIdx] = useState(0);
  const id = HERO_CASES[idx % HERO_CASES.length];
  const kase = useCase(id);
  const [shown, setShown] = useState(0);
  const turn = kase?.turns[0];
  const steps = useMemo(() => (turn ? keySteps(turn).slice(0, 8) : []), [turn]);
  const pb = usePlayback(kase?.replay?.durationMs ?? 0, { autoplay: true, loop: true });
  useEffect(() => {
    setShown(0);
    pb.setT(0);
    const timers = steps.map((_, i) => setTimeout(() => setShown(i + 1), 500 + i * 520));
    const next = setTimeout(() => setIdx((x) => x + 1), 12500);
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(next);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, steps.length]);
  return (
    <div className="window reveal d2">
      <div className="bar">
        <i />
        <i />
        <i />
        <span className="title">PlugAI Studio — {kase?.title ?? '…'}</span>
        <span className="live">recorded run replay</span>
      </div>
      <div className="body">
        <div className="chat">
          {turn && <div className="bubble-u">{turn.prompt}</div>}
          <div className="ticks">
            {steps.map((s, i) => (
              <div key={`${id}${i}`} className={`tick ${s.kind} ${i < shown ? 'on' : ''}`}>
                <span className="b" />
                <span>{s.text.length > 70 ? s.text.slice(0, 70) + '…' : s.text}</span>
              </div>
            ))}
            {shown >= steps.length && kase && (
              <div className="tick on">
                <span className="b" />
                <span>
                  <b>虚拟验证通过</b> · {kase.totals.llmCalls} 次模型调用 · {money(kase.totals.costUsd)}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="stage">
          {kase && <CircuitView kase={kase} t={pb.t} assetBase={assetBase(id)} />}
          <span className="cap">回放来自仿真器真实记录 · t = {(pb.t / 1000).toFixed(2)} s（仿真时间）</span>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="hero">
      <div className="bg-grid" />
      <div className="glow a" />
      <div className="glow b" />
      <div className="wrap">
        <div>
          <span className="eyebrow reveal">
            <span className="dot" /> AI Native Embedded Development Studio
          </span>
          <h1 className="reveal d1">
            <span className="grad">Vibe Coding</span>
            <br />
            for the Physical World.
          </h1>
          <p className="lead reveal d2">
            用一句话描述你想要的硬件行为。PlugAI 规划电路、编写固件、<b>真实交叉编译</b>、<b>虚拟串口烧录</b>，在<b>指令级 MCU 仿真器</b>上运行，并用电路求解器验证每一个 GPIO 信号——灯亮，是因为电流真的流过了它。
          </p>
          <div className="actions reveal d3">
            <StudioLink label="开始创作" />
            <Link to="/cases" className="btn">
              浏览真实案例
            </Link>
          </div>
          <div className="stack reveal d4">
            <span>
              <b>ESP-IDF</b> v5.5.5
            </span>
            <span>
              <b>esp-emu</b> 0.48 · ESP32-C3
            </span>
            <span>
              <b>avr8js</b> · ATmega328P
            </span>
            <span>
              <b>DeepSeek-V4.1-Flash</b> · thinking
            </span>
          </div>
        </div>
        <HeroWindow />
      </div>
    </section>
  );
}

function Band() {
  const proof = useProof();
  const cases = useCases();
  const tests = proof ? ['p0', 'llm', 'e2e'].reduce((a, k) => ({ p: a.p + (proof[k]?.pass ?? 0), t: a.t + (proof[k]?.total ?? 0) }), { p: 0, t: 0 }) : null;
  return (
    <div className="band">
      <div className="wrap">
        <div className="metric reveal">
          <div className="v">
            {tests ? `${tests.p}/${tests.t}` : '—'}
            <small>PASS</small>
          </div>
          <div className="l">验收测试（真实编译 · MCU 执行 · GPIO 因果 · 烧录 · AI 联调），见 reports/</div>
        </div>
        <div className="metric reveal d1">
          <div className="v">{cases ? cases.length : '—'}</div>
          <div className="l">个真实 AI 案例，均保留 Prompt、规划、固件与验证证据</div>
        </div>
        <div className="metric reveal d2">
          <div className="v">
            0.05<small>ms</small>
          </div>
          <div className="l">1 s 闪烁周期的最大偏差，来自仿真 CPU 周期时间戳</div>
        </div>
        <div className="metric reveal d3">
          <div className="v">
            163,840<small>B</small>
          </div>
          <div className="l">esptool ROM 协议写入虚拟 Flash 并逐区 MD5 / SHA-256 校验</div>
        </div>
      </div>
    </div>
  );
}

const STEPS: { n: string; t: string; p: string; real: string; ai?: boolean }[] = [
  { n: '01', t: '理解需求', p: 'DeepSeek Planner 读取当前工程、电路、历史对话与上次验证结果。', real: 'thinking=enabled · effort=high', ai: true },
  { n: '02', t: '规划硬件与验证', p: '选择开发板、元件、引脚与接线，并写出可机器执行的验证场景。', real: 'zod 校验 · 时序可满足性检查', ai: true },
  { n: '03', t: '修改虚拟电路', p: '通过 edit_circuit 工具真实修改电路数据，电路求解器立即计算电流。', real: 'DC 节点分析 · LED 分段线性模型', ai: true },
  { n: '04', t: '生成固件', p: '写出完整 C / C++ 工程源码，写入真实项目目录并 git 提交。', real: 'ESP-IDF C · Arduino C++', ai: true },
  { n: '05', t: '真实交叉编译', p: '调用 riscv32-esp-elf-gcc / avr-gcc，失败时把编译器诊断交还给模型。', real: 'ELF + BIN/HEX · SHA-256 · 工具链版本' },
  { n: '06', t: '虚拟烧录', p: 'ESP32-C3 进入 ROM 下载模式，esptool 经虚拟 UART 写入、校验、回读 Flash。', real: 'socket:// · --no-stub · verify_flash' },
  { n: '07', t: 'MCU 执行', p: '真实 ROM → bootloader → app_main，指令级执行；GPIO 寄存器驱动电路。', real: 'esp-emu 0.48 WASM · avr8js' },
  { n: '08', t: '信号验证与修复', p: '确定性验证引擎检查周期、图案、按钮响应、LCD 画面；失败交给 Debugger，最多 3 轮。', real: 'Verification Engine · 虚拟验证', ai: true },
];

function Pipeline() {
  return (
    <section className="sec" id="how">
      <div className="wrap">
        <div className="center">
          <div className="kicker reveal">How it works</div>
          <h2 className="reveal d1">从一句话，到真实运行的硅片逻辑</h2>
          <p className="sub reveal d2">紫色步骤由大模型决策，青色步骤由确定性工具真实执行。AI 负责创造与诊断，从不负责宣布成功。</p>
        </div>
        <div className="pipe">
          {STEPS.map((s, i) => (
            <div key={s.n} className={`step ${s.ai ? 'ai' : ''} reveal d${(i % 4) + 1}`}>
              <div className="n">
                {s.n} · {s.ai ? 'DeepSeek' : 'Tool'}
              </div>
              <h4>{s.t}</h4>
              <p>{s.p}</p>
              <div className="real">{s.real}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Causality() {
  const chain = [
    { t: 'firmware', h: '固件写寄存器', p: 'gpio_set_level(4, 1) 被编译为 RISC-V 指令，在仿真 CPU 中执行。' },
    { t: 'GPIO_OUT', h: '外设寄存器变化', p: '仿真器更新 GPIO_OUT / ENABLE / IO_MUX，PlugAI 以周期时间戳采样。' },
    { t: 'nets', h: '电路求解', p: '按真实连线组网，求解电压、上拉、二极管导通与电流。' },
    { t: 'LED · LCD', h: '元件状态', p: 'LED 亮度来自正向电流；LCD 画面来自 SPI 字节驱动的 ST7735 帧存。' },
    { t: 'UI', h: '仅渲染', p: '前端不做任何推断与动画，只显示服务器推送的求解结果。' },
  ];
  return (
    <section className="sec" id="real">
      <div className="wrap">
        <div className="kicker reveal">Real, not animated</div>
        <h2 className="reveal d1">每一次灯亮，都有完整因果链</h2>
        <p className="sub reveal d2">串口打印「LED ON」不能证明引脚变高。PlugAI 分别验证 UART 与真实外设状态，把虚拟结果和实体结果严格区分。</p>
        <div className="chain reveal d2">
          {chain.map((c) => (
            <div key={c.t}>
              <div className="flow" />
              <div className="t">{c.t}</div>
              <h5>{c.h}</h5>
              <p>{c.p}</p>
            </div>
          ))}
        </div>
        <div className="proofs">
          <div className="proof reveal d1">
            <h5>
              <span className="ok-ic">✓</span>同一电路，三份固件，三种结果
            </h5>
            <p>恒高 / 恒低 / 翻转三份真实编译固件分别得到常亮、常灭、1000.00 ms 周期闪烁；三者相同即判失败。</p>
          </div>
          <div className="proof reveal d2">
            <h5>
              <span className="ok-ic">✓</span>改线即失效
            </h5>
            <p>固件仍在翻转 GPIO4，把 LED 改接到 GPIO5、断开或反接后灯不再闪——电路模型真正参与运行。</p>
          </div>
          <div className="proof reveal d3">
            <h5>
              <span className="ok-ic">✓</span>按钮必须经过 MCU
            </h5>
            <p>
              按下 → 输入引脚 <code>0</code> @1000.000 ms → 固件输出 <code>GPIO4=1</code> @1002.013 ms → LED 亮。按钮未接线或固件忽略按钮时，灯不亮。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function CaseCard({ c, big }: { c: CaseSummary; big?: boolean }) {
  const [hover, setHover] = useState(false);
  const base = assetBase(c.id);
  const fork = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isStaticSite) {
      if (REPO_URL) window.open(REPO_URL, '_blank', 'noopener');
      return;
    }
    const p = await api.post(`/cases/${c.id}/fork`);
    navigate(`/studio?project=${p.id}`);
  };
  return (
    <div className="card reveal" onClick={() => navigate(`/cases/${c.id}`)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className="media">
        {c.hasVideo && (big || hover) ? (
          <video src={`${base}/video.webm`} poster={c.hasPoster ? `${base}/poster.png` : undefined} autoPlay muted loop playsInline />
        ) : c.hasPoster ? (
          <img src={`${base}/poster.png`} alt={c.title} loading="lazy" />
        ) : (
          <PosterFallback id={c.id} />
        )}
        <span className={`badge ${c.kind === 'boundary' ? 'warn' : ''}`}>{c.kind === 'boundary' ? '诚实的能力边界' : '虚拟验证通过'}</span>
        <span className="board">{c.boardName}</span>
      </div>
      <div className="info">
        <h3>{c.title}</h3>
        <div className="prompt">{c.turns[0]?.prompt}</div>
        <div className="desc">{c.subtitle}</div>
        <div className="meta">
          {c.tags.map((t) => (
            <span key={t} className="chip-s">
              {t}
            </span>
          ))}
        </div>
        <div className="stats">
          <span>
            <b>{c.turns.length}</b> 轮
          </span>
          <span>
            <b>{Math.round(c.totals.wallSec)}</b> s
          </span>
          <span>
            <b>{c.totals.llmCalls}</b> calls
          </span>
          <span>
            <b>{money(c.totals.costUsd)}</b>
          </span>
          {c.kind !== 'boundary' && (
            <a style={{ marginLeft: 'auto', color: '#37e2c4' }} onClick={fork}>
              {isStaticSite ? '本地 Fork →' : 'Fork 继续优化 →'}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function PosterFallback({ id }: { id: string }) {
  const k = useCase(id);
  return k ? <CircuitView kase={k} t={(k.replay?.durationMs ?? 2000) * 0.37} assetBase={assetBase(id)} /> : null;
}

function CasesSection() {
  const cases = useCases();
  useReveal(cases);
  if (!cases) return null;
  const feat = cases.filter((c) => c.featured).slice(0, 3);
  const rest = cases.filter((c) => !feat.includes(c)).slice(0, 6);
  return (
    <section className="sec" id="cases">
      <div className="wrap">
        <div className="cases-head">
          <div>
            <div className="kicker reveal">Cases</div>
            <h2 className="reveal d1">真实跑出来的案例</h2>
            <p className="sub reveal d2">每个案例都来自一次真实的 AI 运行：保留原始 Prompt、模型规划、生成的固件、编译哈希、验证报告与仿真记录。可以一键 Fork，在它的基础上继续对话优化。</p>
          </div>
          <Link to="/cases" className="btn">
            全部 {cases.length} 个案例 <span className="arrow">→</span>
          </Link>
        </div>
        <div className="feat">
          {feat.map((c, i) => (
            <CaseCard key={c.id} c={c} big />
          ))}
        </div>
        <div className="grid">
          {rest.map((c) => (
            <CaseCard key={c.id} c={c} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Agents() {
  const A = [
    { role: 'planner', color: '#c7a6ff', bg: '#1b1533', h: 'Planner', p: '理解需求与工程上下文，产出硬件方案、引脚规划和可执行验证场景。', li: ['inspect_environment', 'get_project_state', 'plan_hardware'] },
    { role: 'coder', color: '#6ec8ff', bg: '#0f2234', h: 'Firmware Coder', p: '修改电路、写完整固件、调用真实编译器并根据诊断修复。', li: ['edit_circuit', 'write_firmware', 'build_firmware'] },
    { role: 'debugger', color: '#ffb36e', bg: '#2b1d10', h: 'Debugger', p: '读取真实 GPIO 边沿、网络电平、UART 与验证报告，判断是代码还是电路问题。', li: ['run_simulation', 'inspect_gpio', 'repair_project'] },
    { role: 'executor', color: '#8ff0c9', bg: '#0b2a20', h: 'Executor + Verifier', p: '确定性执行烧录与验证。模型可以提出测试，但不能宣布通过。', li: ['flash_virtual_device', 'verify_behavior', 'git commit'] },
  ];
  return (
    <section className="sec" id="agents">
      <div className="wrap">
        <div className="kicker reveal">AI Agent</div>
        <h2 className="reveal d1">真正的工具调用循环，而不是一次性代码生成</h2>
        <p className="sub reveal d2">DeepSeek-V4.1-Flash 在思考模式下进行函数调用，每一轮都回传 reasoning_content 与真实工具结果。全程记录 Run ID、模型调用、Token 与成本、文件修改、编译日志、固件哈希与信号证据。</p>
        <div className="agents">
          {A.map((a, i) => (
            <div key={a.role} className={`agent-c reveal d${i + 1}`}>
              <span className="role" style={{ color: a.color, background: a.bg }}>
                {a.role}
              </span>
              <h4>{a.h}</h4>
              <p>{a.p}</p>
              <ul>
                {a.li.map((x) => (
                  <li key={x}>
                    <code>{x}</code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Hardware() {
  return (
    <section className="sec" id="hardware">
      <div className="wrap">
        <div className="kicker reveal">Supported hardware</div>
        <h2 className="reveal d1">只展示真正被仿真的能力</h2>
        <p className="sub reveal d2">没有实际外设模型的器件不会出现在元件库里。做不到的需求，AI 会明确说明能力边界。</p>
        <div className="hw">
          <div className="hw-c reveal d1">
            <h4>ESP32-C3-DevKitM-1</h4>
            <div className="hw-sub">RISC-V RV32IMC · 160 MHz · 主力开发板</div>
            <dl>
              <dt>SDK</dt>
              <dd>ESP-IDF v5.5.5</dd>
              <dt>仿真</dt>
              <dd>Espressif esp-emu 0.48（Apache-2.0）</dd>
              <dt>烧录</dt>
              <dd>esptool ROM 协议 · 虚拟 UART</dd>
              <dt>时间精度</dt>
              <dd>≈12.5 µs 边沿采样</dd>
            </dl>
          </div>
          <div className="hw-c reveal d2">
            <h4>Arduino Uno R3</h4>
            <div className="hw-sub">ATmega328P · 16 MHz · 第二后端</div>
            <dl>
              <dt>SDK</dt>
              <dd>arduino-cli · arduino:avr 1.8.8</dd>
              <dt>仿真</dt>
              <dd>avr8js（MIT）</dd>
              <dt>烧录</dt>
              <dd>直接载入 HEX（如实标注）</dd>
              <dt>时间精度</dt>
              <dd>周期级精确（62.5 ns）</dd>
            </dl>
          </div>
          <div className="hw-c reveal d3">
            <h4>元件库</h4>
            <div className="hw-sub">全部带电气 / 协议模型</div>
            <ul>
              <li>LED（6 色，正向压降与电流）</li>
              <li>限流电阻 · 轻触按钮</li>
              <li>红黄绿交通灯模块</li>
              <li>1.8" ST7735 彩色 LCD（硬件 SPI，Uno）</li>
              <li>UART 串口终端</li>
              <li className="no">ESP32 PWM / RGB WS2812 / OLED / 传感器：未仿真</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function Compare() {
  const rows = [
    ['代码是否真实编译', '是', '否 / 不确定', '是 · ESP-IDF / avr-gcc'],
    ['硬件效果来源', '需要实体板', '无', '指令级 MCU 仿真 + 电路求解'],
    ['电路与接线', '手工', '无', 'AI 规划并修改，错误连线会失效'],
    ['验证方式', '人工观察', '无', '确定性验证引擎 · 证据可审计'],
    ['失败处理', '人工调试', '重新生成', '读取真实诊断与信号，自动修复 ≤3 轮'],
    ['持续迭代', '手动', '常常推倒重来', '同一工程多轮对话 · git 历史可回滚'],
    ['部署实体硬件', '是', '否', '同一工程可直接 esptool / avrdude 烧录'],
  ];
  return (
    <section className="sec">
      <div className="wrap">
        <div className="center">
          <div className="kicker reveal">Why PlugAI</div>
          <h2 className="reveal d1">不是带聊天框的电路编辑器</h2>
        </div>
        <table className="cmp reveal d2">
          <thead>
            <tr>
              <th />
              <th>传统嵌入式 IDE</th>
              <th>通用代码生成</th>
              <th className="us">PlugAI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r[0]}>
                <td>{r[0]}</td>
                <td>{r[1]}</td>
                <td>{r[2]}</td>
                <td className="us">{r[3]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="s-foot">
      <div className="wrap">
        <span>PlugAI · AI Native Embedded Development Studio</span>
        <span>
          所有结果均为「虚拟验证」，未连接实体硬件时不会显示实体验证通过。
          {isStaticSite && ' 公网页面只回放已录制的运行；编译、烧录和工作台在你自己的电脑上。'}
          {isStaticSite && REPO_URL && (
            <>
              {' '}
              <a href={REPO_URL} target="_blank" rel="noreferrer" style={{ color: '#37e2c4' }}>
                GitHub
              </a>
            </>
          )}
        </span>
      </div>
    </footer>
  );
}

export function Landing() {
  useReveal('landing');
  useEffect(() => {
    if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth' }), 200);
  }, []);
  return (
    <div className="site">
      <SiteNav />
      <Hero />
      <Band />
      <Pipeline />
      <Causality />
      <CasesSection />
      <Agents />
      <Hardware />
      <Compare />
      <section className="final">
        <div className="bg-grid" />
        <div className="glow a" style={{ left: '30%', top: '-40%' }} />
        <div className="wrap" style={{ position: 'relative' }}>
          <h2 className="reveal">描述它。看着它真的运行。</h2>
          <p className="sub reveal d1" style={{ margin: '0 auto 30px' }}>
            新建一个 ESP32-C3 或 Arduino Uno 工程，告诉 PlugAI 你想要什么。
          </p>
          <div className="reveal d2" style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <StudioLink label="进入工作台" />
            <Link to="/cases" className="btn">
              看看别人做了什么
            </Link>
          </div>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
