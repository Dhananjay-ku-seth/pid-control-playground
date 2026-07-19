# PID Control Playground

An interactive **line-follower robot simulator** with live PID tuning. Drag the Kp / Ki / Kd sliders and
watch a robot track (or oscillate around) a winding path — the exact control loop from a real line-follower.

Part of the [LabBench](https://labbench-hub.vercel.app/) suite of interactive engineering tools.

**Live demo:** https://pid-control-playground.vercel.app/

## Features
- Top-down robot following a scrolling track (sine / chicane / step / straight)
- Real **double-integrator plant** with sub-stepped Euler integration and integral anti-windup
- Live Kp / Ki / Kd + speed sliders with individual P / I / D term readouts
- Cross-track & RMS error metrics, one-click presets (P-only / PD / PID / Sluggish)
- **⚡ Disturbance** impulse to test closed-loop recovery, plus an error-vs-time strip chart

## LabBench Pro
Sign in to save and reload your gain tunings (Kp/Ki/Kd, speed, track) — part of the same optional ₹29/mo
LabBench Pro subscription as the rest of the suite. Upgrade from
[Logic Circuit Simulator](https://logic-circuit-sim.vercel.app/), which hosts the checkout for all 7 tools.

## Tech
React + TypeScript + Vite. Physics, PID loop, and rendering hand-written on a `<canvas>` — no libraries.
Auth/save-load via Supabase (Postgres + RLS).

## Run locally
```sh
npm install
npm run dev
```

_Built by Dhananjay Kumar Seth — ECE portfolio._
