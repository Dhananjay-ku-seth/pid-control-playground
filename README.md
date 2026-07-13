# PID Control Playground

An interactive **line-follower robot simulator** with live PID tuning. Drag the Kp / Ki / Kd sliders and
watch a robot track (or oscillate around) a winding path — the exact control loop from a real line-follower.

**Live demo:** _add your Vercel URL here_

## Features
- Top-down robot following a scrolling track (sine / chicane / step / straight)
- Real **double-integrator plant** with sub-stepped Euler integration and integral anti-windup
- Live Kp / Ki / Kd + speed sliders with individual P / I / D term readouts
- Cross-track & RMS error metrics, one-click presets (P-only / PD / PID / Sluggish)
- **⚡ Disturbance** impulse to test closed-loop recovery, plus an error-vs-time strip chart

## Tech
React + TypeScript + Vite. Physics, PID loop, and rendering hand-written on a `<canvas>` — no libraries.

## Run locally
```sh
npm install
npm run dev
```

_Built by Dhananjay Kumar Seth — ECE portfolio._
