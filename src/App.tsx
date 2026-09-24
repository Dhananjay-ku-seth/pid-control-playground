import { useEffect, useRef, useState } from "react";
import AuthPanel from "./AuthPanel";
import SavePreset, { type PidConfig } from "./SavePreset";

type Track = "sine" | "chicane" | "step" | "straight";

// track reference curve as a function of world-x (px). Returns lateral offset from center.
function shape(track: Track, wx: number): number {
  switch (track) {
    case "sine": return Math.sin(wx * 0.011);
    case "chicane": return 0.62 * Math.sin(wx * 0.011) + 0.38 * Math.sin(wx * 0.028 + 1);
    case "step": return Math.sign(Math.sin(wx * 0.0065)) * 0.85;
    case "straight": return 0;
  }
}

type Sim = {
  y: number; vy: number; integral: number; lastE: number;
  worldX: number; hist: number[]; rms: number; kick: number;
  pTerm: number; iTerm: number; dTerm: number;
};

type StepResult = {
  data: { t: number; y: number }[];
  target: number;
  metrics: { riseTime: number; overshoot: number; settlingTime: number | null; steadyStateError: number };
};

// Isolated step-response test: same double-integrator plant + PID law as the
// live loop, but against a fixed setpoint instead of a scrolling track, run
// as one deterministic pass so textbook metrics can be read off directly.
function runStepResponse(kp: number, ki: number, kd: number, target = 220, duration = 8, dt = 0.002): StepResult {
  let y = 0, vy = 0, integral = 0, lastE = -target;
  const data: { t: number; y: number }[] = [];
  const steps = Math.round(duration / dt);
  for (let n = 0; n <= steps; n++) {
    const t = n * dt;
    const e = y - target;
    integral += e * dt;
    integral = Math.max(-260, Math.min(260, integral));
    const dedt = (e - lastE) / dt;
    lastE = e;
    const u = kp * e + ki * integral + kd * dedt;
    const accel = -u - 0.9 * vy;
    vy += accel * dt;
    vy = Math.max(-900, Math.min(900, vy));
    y += vy * dt;
    data.push({ t, y });
  }
  // Average over the last 0.25 s so a still-ringing response is not judged on one sample.
  const tail = data.slice(-Math.max(1, Math.round(0.25 / dt)));
  const steadyStateError = target - tail.reduce((sum, d) => sum + d.y, 0) / tail.length;
  let riseTime = duration;
  for (const d of data) { if (Math.abs(d.y) >= 0.9 * Math.abs(target)) { riseTime = d.t; break; } }
  let peak = 0;
  for (const d of data) if (Math.abs(d.y) > Math.abs(peak)) peak = d.y;
  const overshoot = target !== 0 ? Math.max(0, ((peak - target) / target) * 100) : 0;
  const band = Math.abs(target) * 0.05;
  // Settling time = the last moment the response was outside the band. If it is still outside at the end of
  // the test it never settled, which is reported as null rather than as the test duration.
  let settlingTime: number | null = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    if (Math.abs(data[i].y - target) > band) { settlingTime = i === data.length - 1 ? null : data[i].t; break; }
  }
  return { data, target, metrics: { riseTime, overshoot, settlingTime, steadyStateError } };
}

const PRESETS: Record<string, { kp: number; ki: number; kd: number; note: string }> = {
  "P-only (unstable)": { kp: 9, ki: 0, kd: 0, note: "Proportional alone → endless oscillation / overshoot" },
  "PD (damped)":       { kp: 9, ki: 0, kd: 5, note: "Derivative adds damping → smooth tracking" },
  "PID (tuned)":       { kp: 9, ki: 2.2, kd: 5, note: "Integral kills steady-state offset on curves" },
  "Sluggish":          { kp: 2.5, ki: 0, kd: 1, note: "Low gain → slow, laggy, can't keep up" },
};

export default function App() {
  const [kp, setKp] = useState(9);
  const [ki, setKi] = useState(0);
  const [kd, setKd] = useState(5);
  const [speed, setSpeed] = useState(130);
  const [track, setTrack] = useState<Track>("sine");
  const [running, setRunning] = useState(true);
  const [rms, setRms] = useState(0);
  const [err, setErr] = useState(0);
  const [terms, setTerms] = useState({ p: 0, i: 0, d: 0 });
  const [stepResult, setStepResult] = useState<StepResult | null>(null);

  const road = useRef<HTMLCanvasElement>(null);
  const plot = useRef<HTMLCanvasElement>(null);
  const stepCanvas = useRef<HTMLCanvasElement>(null);
  const raf = useRef<number>(0);
  const last = useRef<number>(0);
  const sim = useRef<Sim>({ y: 0, vy: 0, integral: 0, lastE: 0, worldX: 0, hist: [], rms: 0, kick: 0, pTerm: 0, iTerm: 0, dTerm: 0 });

  // keep latest control params readable inside the rAF loop
  const params = useRef({ kp, ki, kd, speed, track, running });
  params.current = { kp, ki, kd, speed, track, running };

  function reset() {
    const rd = road.current;
    const H = rd ? rd.height : 300;
    sim.current = { y: H / 2, vy: 0, integral: 0, lastE: 0, worldX: 0, hist: [], rms: 0, kick: 0, pTerm: 0, iTerm: 0, dTerm: 0 };
  }

  function applyPreset(name: string) {
    const p = PRESETS[name];
    setKp(p.kp); setKi(p.ki); setKd(p.kd);
  }

  useEffect(() => {
    reset();
    const step = (ts: number) => {
      const s = sim.current;
      const rd = road.current, pl = plot.current;
      const { kp, ki, kd, speed, track, running } = params.current;
      if (!rd || !pl) { raf.current = requestAnimationFrame(step); return; }
      const W = rd.width, H = rd.height, cy = H / 2, amp = H * 0.34;
      const robotX = W * 0.32; // fixed screen x of the robot

      let dt = last.current ? (ts - last.current) / 1000 : 0.016;
      last.current = ts;
      dt = Math.min(dt, 0.033);

      if (running) {
        // sub-step the integrator for numerical stability
        const sub = 3, h = dt / sub;
        for (let k = 0; k < sub; k++) {
          s.worldX += speed * h;
          const ref = cy + amp * shape(track, s.worldX);
          const e = s.y - ref;                        // cross-track error (px)
          s.integral += e * h;
          s.integral = Math.max(-260, Math.min(260, s.integral)); // anti-windup
          const dedt = (e - s.lastE) / h;
          s.lastE = e;

          const p = kp * e, i = ki * s.integral, d = kd * dedt;
          const u = p + i + d;                         // control effort
          s.pTerm = p; s.iTerm = i; s.dTerm = d;

          // plant: steered mass (double integrator) with light natural damping
          const accel = -u - 0.9 * s.vy + s.kick;
          s.kick = 0;
          s.vy += accel * h;
          s.vy = Math.max(-900, Math.min(900, s.vy));
          s.y += s.vy * h;
          if (s.y < 14) { s.y = 14; s.vy = 0; }
          if (s.y > H - 14) { s.y = H - 14; s.vy = 0; }

          s.hist.push(e);
          if (s.hist.length > 520) s.hist.shift();
        }
        // RMS over recent window
        const win = s.hist.slice(-260);
        s.rms = Math.sqrt(win.reduce((a, v) => a + v * v, 0) / Math.max(1, win.length));
      }

      // ---------- draw road ----------
      const c = rd.getContext("2d")!;
      c.fillStyle = "#0a0f0b"; c.fillRect(0, 0, W, H);
      // reference track (the line to follow)
      c.lineWidth = 14; c.strokeStyle = "#1c2c20"; c.beginPath();
      for (let x = 0; x <= W; x += 4) {
        const wx = s.worldX + (x - robotX);
        const y = cy + amp * shape(track, wx);
        x === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.stroke();
      c.lineWidth = 3; c.strokeStyle = "#34d39955"; c.setLineDash([10, 10]); c.beginPath();
      for (let x = 0; x <= W; x += 4) {
        const wx = s.worldX + (x - robotX);
        const y = cy + amp * shape(track, wx);
        x === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.stroke(); c.setLineDash([]);

      // robot
      const refAtRobot = cy + amp * shape(track, s.worldX);
      const steer = Math.atan2(s.vy, speed);
      c.save();
      c.translate(robotX, s.y);
      c.rotate(steer * 0.5);
      // error tick to the line
      c.restore();
      c.strokeStyle = "#f59e0b"; c.lineWidth = 2; c.beginPath();
      c.moveTo(robotX, s.y); c.lineTo(robotX, refAtRobot); c.stroke();
      c.save();
      c.translate(robotX, s.y);
      c.rotate(steer * 0.5);
      c.fillStyle = "#22c55e"; c.strokeStyle = "#86efac"; c.lineWidth = 2;
      roundRect(c, -16, -11, 32, 22, 5); c.fill(); c.stroke();
      // sensor bar
      c.fillStyle = "#052e16";
      c.fillRect(14, -9, 6, 18);
      c.fillStyle = "#bef264";
      for (let sdx = -8; sdx <= 8; sdx += 4) c.fillRect(18, sdx - 1, 3, 2);
      c.restore();

      // ---------- draw error plot ----------
      const p2 = pl.getContext("2d")!;
      const PW = pl.width, PH = pl.height, mid = PH / 2;
      p2.fillStyle = "#0a0f0b"; p2.fillRect(0, 0, PW, PH);
      p2.strokeStyle = "#1f2a22"; p2.lineWidth = 1;
      for (let gy = 0; gy <= PH; gy += PH / 4) { p2.beginPath(); p2.moveTo(0, gy); p2.lineTo(PW, gy); p2.stroke(); }
      p2.strokeStyle = "#3f6b52"; p2.setLineDash([6, 6]); p2.beginPath();
      p2.moveTo(0, mid); p2.lineTo(PW, mid); p2.stroke(); p2.setLineDash([]);
      p2.fillStyle = "#4b7a5f"; p2.font = "11px ui-monospace, monospace";
      p2.fillText("error = 0 (on the line)", 8, mid - 6);
      const scale = mid / (amp * 1.15);
      p2.strokeStyle = "#34d399"; p2.lineWidth = 2; p2.beginPath();
      const hist = s.hist;
      for (let idx = 0; idx < hist.length; idx++) {
        const x = (idx / 520) * PW;
        const y = mid + hist[idx] * scale;
        idx === 0 ? p2.moveTo(x, y) : p2.lineTo(x, y);
      }
      p2.stroke();

      setRms(Math.round(s.rms));
      setErr(Math.round(s.lastE));
      setTerms({ p: Math.round(s.pTerm), i: Math.round(s.iTerm), d: Math.round(s.dTerm) });

      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  useEffect(() => {
    const cv = stepCanvas.current;
    if (!cv || !stepResult) return;
    const c = cv.getContext("2d")!;
    const W = cv.width, H = cv.height, padL = 44, padB = 26, padT = 10, padR = 10;
    const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
    const { data, target } = stepResult;
    const maxY = Math.max(target * 1.3, ...data.map((d) => Math.abs(d.y))) || 1;
    const duration = data[data.length - 1]?.t || 1;
    const xAt = (t: number) => x0 + (t / duration) * (x1 - x0);
    const yAt = (v: number) => y1 - ((v + maxY) / (2 * maxY)) * (y1 - y0);

    c.fillStyle = "#0a0f0b"; c.fillRect(0, 0, W, H);
    c.strokeStyle = "#1f2a22"; c.lineWidth = 1;
    for (let gy = 0; gy <= 4; gy++) { const y = y0 + (gy / 4) * (y1 - y0); c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke(); }
    // target line
    c.strokeStyle = "#f59e0b"; c.setLineDash([6, 6]); c.lineWidth = 1.5; c.beginPath();
    c.moveTo(x0, yAt(target)); c.lineTo(x1, yAt(target)); c.stroke(); c.setLineDash([]);
    c.fillStyle = "#f59e0b"; c.font = "10px ui-monospace, monospace"; c.fillText("target", x1 - 40, yAt(target) - 4);
    // response curve
    c.strokeStyle = "#34d399"; c.lineWidth = 2; c.beginPath();
    data.forEach((d, i) => { const x = xAt(d.t), y = yAt(d.y); i === 0 ? c.moveTo(x, y) : c.lineTo(x, y); });
    c.stroke();
    // axis labels
    c.fillStyle = "#4b7a5f"; c.font = "10px ui-monospace, monospace";
    c.fillText("0s", x0 - 4, y1 + 14);
    c.fillText(duration.toFixed(1) + "s", x1 - 20, y1 + 14);
    c.save(); c.translate(12, (y0 + y1) / 2); c.rotate(-Math.PI / 2); c.fillText("output", 0, 0); c.restore();
  }, [stepResult]);

  return (
    <div className="app">
      <header>
        <div className="mark">◎</div>
        <div>
          <h1>PID CONTROL PLAYGROUND</h1>
          <p>Line-follower robot · closed-loop steering · tune the gains, watch it track — or oscillate</p>
        </div>
        <div className="badges">
          <AuthPanel />
          <div className="badge-links">
            <a className="labbench-badge" href="https://labbench-hub.vercel.app/" target="_blank" rel="noopener noreferrer">⚡ LabBench</a>
            <a className="src" href="https://dhananjay-kumar-seth.vercel.app/" target="_blank" rel="noopener noreferrer">ECE Portfolio · Dhananjay Seth</a>
          </div>
        </div>
      </header>

      <div className="savebar">
        <SavePreset
          config={{ kp, ki, kd, speed, track }}
          onLoad={(c: PidConfig) => {
            setKp(c.kp); setKi(c.ki); setKd(c.kd); setSpeed(c.speed); setTrack(c.track);
          }}
        />
      </div>

      <div className="stage">
        <div className="scope">
          <div className="scope-head"><span>◎ ROBOT VIEW</span><small>green = reference line · orange = cross-track error</small></div>
          <canvas ref={road} width={900} height={300} />
        </div>
        <div className="scope">
          <div className="scope-head"><span>∿ ERROR vs TIME</span><small>the control response — overshoot, oscillation, settling</small></div>
          <canvas ref={plot} width={900} height={150} />
        </div>
      </div>

      <div className="panel">
        <div className="metrics">
          <Metric label="Cross-track error" v={err + " px"} tone={Math.abs(err) < 12 ? "good" : "warn"} />
          <Metric label="RMS error" v={rms + " px"} tone={rms < 18 ? "good" : rms < 45 ? "warn" : "bad"} />
          <Metric label="P term" v={String(terms.p)} tone="p" />
          <Metric label="I term" v={String(terms.i)} tone="i" />
          <Metric label="D term" v={String(terms.d)} tone="d" />
        </div>

        <div className="controls">
          <div className="gains">
            <Gain label="Kp — Proportional" v={kp} min={0} max={20} step={0.1} on={setKp} c="#f43f5e" />
            <Gain label="Ki — Integral" v={ki} min={0} max={8} step={0.1} on={setKi} c="#a855f7" />
            <Gain label="Kd — Derivative" v={kd} min={0} max={14} step={0.1} on={setKd} c="#22d3ee" />
            <Gain label="Robot speed" v={speed} min={40} max={260} step={5} on={setSpeed} c="#34d399" unit=" px/s" />
          </div>

          <div className="side">
            <div className="block">
              <span className="blabel">Track</span>
              <div className="seg">
                {(["sine", "chicane", "step", "straight"] as Track[]).map((t) => (
                  <button key={t} className={track === t ? "on" : ""} onClick={() => setTrack(t)}>{t}</button>
                ))}
              </div>
            </div>
            <div className="block">
              <span className="blabel">Presets</span>
              <div className="presets">
                {Object.keys(PRESETS).map((name) => (
                  <button key={name} onClick={() => applyPreset(name)} title={PRESETS[name].note}>{name}</button>
                ))}
              </div>
            </div>
            <div className="block actions">
              <button className="kick" onClick={() => { sim.current.kick = 520 * (Math.random() > 0.5 ? 1 : -1); }}>⚡ Disturbance</button>
              <button onClick={reset}>↺ Reset</button>
              <button onClick={() => setStepResult(runStepResponse(kp, ki, kd))}>📊 Step Response Test</button>
            </div>
          </div>
        </div>

        {stepResult && (
          <div className="scope">
            <div className="scope-head"><span>📊 STEP RESPONSE</span><small>isolated setpoint jump — rise time, overshoot, settling, steady-state error</small></div>
            <canvas ref={stepCanvas} width={900} height={180} />
            <div className="step-metrics">
              <Metric label="Rise time (90%)" v={stepResult.metrics.riseTime.toFixed(2) + "s"} tone="p" />
              <Metric label="Overshoot" v={stepResult.metrics.overshoot.toFixed(1) + "%"}
                tone={stepResult.metrics.overshoot < 5 ? "good" : stepResult.metrics.overshoot < 25 ? "warn" : "bad"} />
              <Metric label="Settling time (±5%)" v={stepResult.metrics.settlingTime === null ? "not settled" : stepResult.metrics.settlingTime.toFixed(2) + "s"} tone={stepResult.metrics.settlingTime === null ? "bad" : "d"} />
              <Metric label={stepResult.metrics.settlingTime === null ? "Error at end (not settled)" : "Steady-state error"} v={stepResult.metrics.steadyStateError.toFixed(1) + " px"}
                tone={Math.abs(stepResult.metrics.steadyStateError) < 5 ? "good" : "warn"} />
            </div>
          </div>
        )}

        <p className="hint">
          Try it: hit <b>P-only</b> and watch it overshoot the line forever. Add <b>Kd</b> and the wobble damps out.
          Switch the track to <b>step</b> for a classic step-response overshoot, or <b>straight</b> then punch
          <b> ⚡ Disturbance</b> to see the loop recover. This is the exact controller from the Line Follower robot.
        </p>
      </div>

      <footer>Double-integrator plant · sub-stepped Euler integration · anti-windup clamp on the integral term · no libraries.</footer>
    </div>
  );
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function Metric({ label, v, tone }: { label: string; v: string; tone: string }) {
  return (
    <div className={"metric t-" + tone}>
      <span className="m-val">{v}</span>
      <span className="m-label">{label}</span>
    </div>
  );
}

function Gain({ label, v, min, max, step, on, c, unit }: {
  label: string; v: number; min: number; max: number; step: number;
  on: (n: number) => void; c: string; unit?: string;
}) {
  return (
    <label className="gain">
      <span className="g-label"><i style={{ background: c }} />{label}</span>
      <input type="range" min={min} max={max} step={step} value={v}
        style={{ accentColor: c }} onChange={(e) => on(parseFloat(e.target.value))} />
      <span className="g-val">{v}{unit ?? ""}</span>
    </label>
  );
}
