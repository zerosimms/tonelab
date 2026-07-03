import React, { useRef, useState, useEffect, useCallback } from "react";
import { Play, Shuffle, Download, Volume2 } from "lucide-react";

// ---------- color tokens ----------
// Inline styles (not Tailwind arbitrary-value classes) are used for every
// background/text/border color below, since arbitrary bracket classes like
// bg-[#hex] don't reliably apply on the mobile artifact renderer.
const COLORS = {
  bg: "#F5F5F3",
  panel: "#FFFFFF",
  border: "#E3E1DA",
  textPrimary: "#1B1B18",
  textMuted: "#77746C",
  accent: "#E8944A",
  accentText: "#1B1B18",
  secondary: "#0E7490",
  scopeBg: "#0F1115",
  scopeCenter: "#3A3F46",
};

// ---------- sound theory helpers ----------

const SHAPES = {
  single: { label: "Single", semis: [0] },
  up2: { label: "Rising 2-tone", semis: [0, 4] },
  down2: { label: "Falling 2-tone", semis: [0, -5] },
  up3: { label: "Rising 3-tone", semis: [0, 4, 7] },
  down3: { label: "Falling 3-tone", semis: [0, -3, -7] },
  repeat3: { label: "Triple pulse", semis: [0, 0, 0] },
  zigzag: { label: "Zigzag", semis: [0, 7, -5, 3] },
  trill: { label: "Trill", semis: [0, 2, 0, 2, 0] },
  cascade: { label: "Cascade", semis: [0, 3, 6, 9, 12] },
  droid: { label: "Droid chatter", semis: [0, -2, 5, -3, 2] },
};

const WAVEFORMS = ["sine", "triangle", "square", "sawtooth"];

// Small deterministic PRNG so a given seed always reproduces the same
// wobble/chirp pattern (keeps the downloaded file matching the last preview).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_EXTRAS = { sciFi: false, sciFiAmount: 0.5, seed: 1 };

const PRESETS = [
  { name: "Classic Chime", cfg: { ...DEFAULT_EXTRAS, waveform: "sine", shape: "up2", baseFreq: 587, duration: 180, attack: 8, decay: 220, sweep: "none", sweepAmount: 0.2, noteInterval: 140, volume: 0.5 } },
  { name: "Digital Blip", cfg: { ...DEFAULT_EXTRAS, waveform: "square", shape: "single", baseFreq: 880, duration: 70, attack: 2, decay: 60, sweep: "none", sweepAmount: 0.2, noteInterval: 90, volume: 0.35 } },
  { name: "Soft Pop", cfg: { ...DEFAULT_EXTRAS, waveform: "sine", shape: "single", baseFreq: 420, duration: 110, attack: 4, decay: 90, sweep: "down", sweepAmount: 0.35, noteInterval: 100, volume: 0.5 } },
  { name: "Alert Pulse", cfg: { ...DEFAULT_EXTRAS, waveform: "triangle", shape: "repeat3", baseFreq: 700, duration: 90, attack: 3, decay: 70, sweep: "none", sweepAmount: 0.2, noteInterval: 110, volume: 0.5 } },
  { name: "Marimba Ping", cfg: { ...DEFAULT_EXTRAS, waveform: "triangle", shape: "single", baseFreq: 523, duration: 260, attack: 5, decay: 240, sweep: "down", sweepAmount: 0.08, noteInterval: 140, volume: 0.5 } },
  { name: "Retro Ding", cfg: { ...DEFAULT_EXTRAS, waveform: "square", shape: "down2", baseFreq: 784, duration: 130, attack: 3, decay: 120, sweep: "none", sweepAmount: 0.2, noteInterval: 120, volume: 0.4 } },
  { name: "Droid Chatter", cfg: { ...DEFAULT_EXTRAS, sciFi: true, sciFiAmount: 0.65, seed: 42, waveform: "square", shape: "droid", baseFreq: 520, duration: 95, attack: 2, decay: 75, sweep: "none", sweepAmount: 0.2, noteInterval: 75, volume: 0.45 } },
  { name: "Laser Scanner", cfg: { ...DEFAULT_EXTRAS, sciFi: true, sciFiAmount: 0.85, seed: 7, waveform: "sawtooth", shape: "single", baseFreq: 900, duration: 220, attack: 2, decay: 200, sweep: "down", sweepAmount: 0.5, noteInterval: 100, volume: 0.4 } },
  { name: "Glyph Pulse", cfg: { ...DEFAULT_EXTRAS, waveform: "square", shape: "trill", baseFreq: 660, duration: 40, attack: 1, decay: 30, sweep: "none", sweepAmount: 0.2, noteInterval: 85, volume: 0.32 } },
  { name: "Crystal Bell", cfg: { ...DEFAULT_EXTRAS, waveform: "sine", shape: "up3", baseFreq: 660, duration: 200, attack: 6, decay: 320, sweep: "up", sweepAmount: 0.05, noteInterval: 110, volume: 0.45 } },
  { name: "UI Tap", cfg: { ...DEFAULT_EXTRAS, waveform: "square", shape: "single", baseFreq: 1200, duration: 30, attack: 1, decay: 24, sweep: "none", sweepAmount: 0.2, noteInterval: 60, volume: 0.3 } },
  { name: "Vintage Pager", cfg: { ...DEFAULT_EXTRAS, waveform: "square", shape: "repeat3", baseFreq: 440, duration: 130, attack: 2, decay: 100, sweep: "none", sweepAmount: 0.2, noteInterval: 160, volume: 0.4 } },
];

function freqFor(base, semi) {
  return base * Math.pow(2, semi / 12);
}

function totalDurationMs(cfg) {
  const notes = SHAPES[cfg.shape].semis.length;
  return (notes - 1) * cfg.noteInterval + cfg.duration + 60;
}

// Schedules the whole sequence onto any BaseAudioContext-like object (live or offline).
// Returns the master gain node it was routed through (caller decides what to connect it to).
function scheduleSequence(ctx, cfg, startTime) {
  const master = ctx.createGain();
  master.gain.value = 1;

  const semis = SHAPES[cfg.shape].semis;
  semis.forEach((semi, i) => {
    const t0 = startTime + (i * cfg.noteInterval) / 1000;
    const dur = cfg.duration / 1000;
    const freq = freqFor(cfg.baseFreq, semi);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = cfg.waveform;

    if (cfg.sciFi) {
      const rand = mulberry32(((cfg.seed || 1) * 7919 + i * 104729) >>> 0);
      const points = 10 + Math.floor(rand() * 8);
      const curve = new Float32Array(points);
      let trendEnd = freq;
      if (cfg.sweep === "up") trendEnd = freq * (1 + cfg.sweepAmount);
      if (cfg.sweep === "down") trendEnd = freq * (1 - cfg.sweepAmount);
      const swing = 3 + cfg.sciFiAmount * 9; // semitones of chirp/wobble
      for (let p = 0; p < points; p++) {
        const frac = p / (points - 1);
        const trend = freq + (trendEnd - freq) * frac;
        const wobbleSemis = (rand() * 2 - 1) * swing;
        curve[p] = Math.max(40, trend * Math.pow(2, wobbleSemis / 12));
      }
      osc.frequency.setValueCurveAtTime(curve, t0, dur);
    } else {
      osc.frequency.setValueAtTime(Math.max(20, freq), t0);
      if (cfg.sweep !== "none") {
        const target =
          cfg.sweep === "up"
            ? freq * (1 + cfg.sweepAmount)
            : freq * (1 - cfg.sweepAmount);
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, target), t0 + dur);
      }
    }

    const atk = Math.min(cfg.attack / 1000, dur * 0.9);
    const dec = Math.max(dur - atk, 0.01);

    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(cfg.volume, t0 + atk);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + atk + dec);

    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  });

  return master;
}

// ---------- WAV encoding (16-bit PCM, mono) ----------

function encodeWav(audioBuffer) {
  const numChannels = 1;
  const sampleRate = audioBuffer.sampleRate;
  const data = audioBuffer.getChannelData(0);
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + data.length * bytesPerSample);
  const view = new DataView(buffer);

  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + data.length * bytesPerSample, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, data.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// ---------- UI ----------

function KnobLabel({ children, className }) {
  return (
    <span
      className={`text-[10px] uppercase tracking-[0.15em] font-mono ${className || ""}`}
      style={{ color: COLORS.textMuted }}
    >
      {children}
    </span>
  );
}

function Readout({ children }) {
  return (
    <span className="font-mono text-sm tabular-nums" style={{ color: COLORS.accent }}>
      {children}
    </span>
  );
}

function Panel({ title, children }) {
  return (
    <div className="rounded-lg p-4 border" style={{ backgroundColor: COLORS.panel, borderColor: COLORS.border }}>
      <div className="text-[11px] uppercase tracking-[0.2em] font-mono mb-3" style={{ color: COLORS.secondary }}>
        {title}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Slider({ label, value, min, max, step, unit, onChange, onCommit, format }) {
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1.5">
        <KnobLabel>{label}</KnobLabel>
        <Readout>{format ? format(value) : value}{unit}</Readout>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onMouseUp={onCommit}
        onTouchEnd={onCommit}
        onKeyUp={onCommit}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
        style={{ backgroundColor: COLORS.border, accentColor: COLORS.accent }}
      />
    </div>
  );
}

function SegButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className="px-2.5 py-1.5 rounded-md text-xs font-mono uppercase tracking-wide border transition-colors"
      style={
        active
          ? { backgroundColor: COLORS.accent, color: COLORS.accentText, borderColor: COLORS.accent }
          : { backgroundColor: COLORS.panel, color: COLORS.textMuted, borderColor: COLORS.border }
      }
    >
      {children}
    </button>
  );
}

export default function ToneLab() {
  const [cfg, setCfg] = useState(PRESETS[0].cfg);
  const [activePreset, setActivePreset] = useState(PRESETS[0].name);
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState("Ready");

  const audioCtxRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const analyserRef = useRef(null);
  const cfgRef = useRef(cfg);

  const set = (patch, autoplay = false) => {
    setActivePreset(null);
    const next = { ...cfgRef.current, ...patch };
    cfgRef.current = next;
    setCfg(next);
    if (autoplay) requestAnimationFrame(() => play());
  };

  const getCtx = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtxRef.current;
  };

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx2d = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    // Find a rising zero-crossing near the start of the buffer and draw from
    // there each frame, so the trace holds steady ("locked") instead of
    // sliding around like an untriggered scope.
    const searchLimit = Math.floor(bufferLength / 2);
    let triggerIndex = 0;
    for (let i = 1; i < searchLimit; i++) {
      if (dataArray[i - 1] < 128 && dataArray[i] >= 128) {
        triggerIndex = i;
        break;
      }
    }
    const drawLength = bufferLength - searchLimit;

    ctx2d.fillStyle = COLORS.scopeBg;
    ctx2d.fillRect(0, 0, w, h);

    // faint center line
    ctx2d.strokeStyle = COLORS.scopeCenter;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, h / 2);
    ctx2d.lineTo(w, h / 2);
    ctx2d.stroke();

    ctx2d.lineWidth = 2;
    ctx2d.strokeStyle = COLORS.accent;
    ctx2d.shadowColor = COLORS.accent;
    ctx2d.shadowBlur = 6;
    ctx2d.beginPath();
    const slice = w / drawLength;
    let x = 0;
    for (let i = 0; i < drawLength; i++) {
      const v = dataArray[triggerIndex + i] / 128.0;
      const y = (v * h) / 2;
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
      x += slice;
    }
    ctx2d.stroke();
    ctx2d.shadowBlur = 0;

    rafRef.current = requestAnimationFrame(drawFrame);
  }, []);

  const drawIdle = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx2d.fillStyle = COLORS.scopeBg;
    ctx2d.fillRect(0, 0, w, h);
    ctx2d.strokeStyle = COLORS.scopeCenter;
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, h / 2);
    ctx2d.lineTo(w, h / 2);
    ctx2d.stroke();
  }, []);

  useEffect(() => {
    drawIdle();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [drawIdle]);

  const play = () => {
    const c = cfgRef.current;
    const ctx = getCtx();
    if (ctx.state === "suspended") ctx.resume();

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyserRef.current = analyser;

    const master = scheduleSequence(ctx, c, ctx.currentTime + 0.02);
    master.connect(analyser);
    analyser.connect(ctx.destination);

    setIsPlaying(true);
    setStatus("Playing\u2026");
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    drawFrame();

    const totalMs = totalDurationMs(c);
    setTimeout(() => {
      setIsPlaying(false);
      setStatus("Ready");
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      // leave the last waveform frame locked on screen rather than clearing it
    }, totalMs);
  };

  const randomize = () => {
    const waveform = WAVEFORMS[Math.floor(Math.random() * WAVEFORMS.length)];
    const shapeKeys = Object.keys(SHAPES);
    const shape = shapeKeys[Math.floor(Math.random() * shapeKeys.length)];
    const sweepOpts = ["none", "none", "up", "down"];
    const sweep = sweepOpts[Math.floor(Math.random() * sweepOpts.length)];
    const sciFi = Math.random() < 0.35;
    const next = {
      waveform,
      shape,
      baseFreq: Math.round(220 + Math.random() * 900),
      duration: Math.round(60 + Math.random() * 200),
      attack: Math.round(2 + Math.random() * 20),
      decay: Math.round(50 + Math.random() * 180),
      sweep,
      sweepAmount: parseFloat((0.1 + Math.random() * 0.4).toFixed(2)),
      noteInterval: Math.round(60 + Math.random() * 120),
      volume: 0.45,
      sciFi,
      sciFiAmount: parseFloat((0.3 + Math.random() * 0.6).toFixed(2)),
      seed: Math.floor(Math.random() * 1e9),
    };
    setActivePreset(null);
    cfgRef.current = next;
    setCfg(next);
    requestAnimationFrame(() => play());
  };

  const download = async () => {
    setStatus("Rendering\u2026");
    try {
      const c = cfgRef.current;
      const totalMs = totalDurationMs(c);
      const sampleRate = 44100;
      const offlineCtx = new OfflineAudioContext(1, Math.ceil((sampleRate * totalMs) / 1000), sampleRate);
      const master = scheduleSequence(offlineCtx, c, 0.01);
      master.connect(offlineCtx.destination);
      const rendered = await offlineCtx.startRendering();
      const wavBlob = encodeWav(rendered);
      const fileBlob = new Blob([wavBlob], { type: "application/octet-stream" });
      const url = URL.createObjectURL(fileBlob);
      const filename = `tone-${activePreset ? activePreset.toLowerCase().replace(/\s+/g, "-") : "custom"}.wav`;

      let triggered = false;
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        triggered = true;
      } catch (_) {
        triggered = false;
      }

      window.open(url, "_blank");

      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setStatus(triggered ? "Saved / opened in new tab" : "Opened in new tab");
      setTimeout(() => setStatus("Ready"), 2500);
    } catch (err) {
      console.error("Download failed:", err);
      setStatus("Download failed \u2014 see console");
      setTimeout(() => setStatus("Ready"), 2500);
    }
  };

  return (
    <div className="min-h-screen font-sans flex justify-center p-4" style={{ backgroundColor: COLORS.bg, color: COLORS.textPrimary }}>
      <div className="w-full max-w-md">
        {/* sticky header + scope + transport, always visible while scrolling controls below */}
        <div
          className="sticky top-0 z-20 pt-1 pb-3 -mx-1 px-1 border-b"
          style={{ backgroundColor: COLORS.bg, borderColor: COLORS.border }}
        >
          <div className="flex items-baseline justify-between mb-3 px-1">
            <div>
              <h1 className="font-mono text-lg tracking-tight" style={{ color: COLORS.textPrimary }}>TONE LAB</h1>
              <p className="text-xs font-mono" style={{ color: COLORS.textMuted }}>notification &amp; ringtone module</p>
            </div>
            <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: COLORS.secondary }}>{status}</div>
          </div>

          <div className="rounded-lg overflow-hidden border mb-3" style={{ borderColor: COLORS.border, backgroundColor: COLORS.scopeBg }}>
            <canvas
              ref={canvasRef}
              width={400}
              height={140}
              className="w-full h-[140px] block"
              style={{ backgroundColor: COLORS.scopeBg }}
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={play}
              className="flex-1 flex items-center justify-center gap-2 font-mono uppercase text-sm tracking-wide py-2.5 rounded-md hover:brightness-110 active:scale-[0.98] transition"
              style={{ backgroundColor: COLORS.accent, color: COLORS.accentText }}
            >
              <Play size={16} fill={COLORS.accentText} /> Play
            </button>
            <button
              onClick={randomize}
              className="px-3.5 flex items-center justify-center border rounded-md transition"
              style={{ backgroundColor: COLORS.panel, borderColor: COLORS.border, color: COLORS.secondary }}
              title="Randomize"
            >
              <Shuffle size={16} />
            </button>
            <button
              onClick={download}
              className="px-3.5 flex items-center justify-center border rounded-md transition"
              style={{ backgroundColor: COLORS.panel, borderColor: COLORS.border, color: COLORS.textMuted }}
              title="Download WAV"
            >
              <Download size={16} />
            </button>
          </div>
        </div>

        {/* presets */}
        <div className="mt-4 mb-4">
          <KnobLabel className="mb-2 block">Patches</KnobLabel>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {PRESETS.map((p) => (
              <SegButton
                key={p.name}
                active={activePreset === p.name}
                onClick={() => {
                  cfgRef.current = p.cfg;
                  setActivePreset(p.name);
                  setCfg(p.cfg);
                  requestAnimationFrame(() => play());
                }}
              >
                {p.name}
              </SegButton>
            ))}
          </div>
        </div>

        {/* controls */}
        <div className="space-y-3">
          <Panel title="Shape">
            <div>
              <KnobLabel className="mb-1.5 block">Waveform</KnobLabel>
              <div className="flex gap-1.5 flex-wrap mt-1.5">
                {WAVEFORMS.map((w) => (
                  <SegButton key={w} active={cfg.waveform === w} onClick={() => set({ waveform: w }, true)}>
                    {w}
                  </SegButton>
                ))}
              </div>
            </div>
            <div>
              <KnobLabel className="mb-1.5 block">Melody</KnobLabel>
              <div className="flex gap-1.5 flex-wrap mt-1.5">
                {Object.entries(SHAPES).map(([key, s]) => (
                  <SegButton key={key} active={cfg.shape === key} onClick={() => set({ shape: key }, true)}>
                    {s.label}
                  </SegButton>
                ))}
              </div>
            </div>
          </Panel>

          <Panel title="Pitch">
            <Slider
              label="Base frequency"
              value={cfg.baseFreq}
              min={150}
              max={1500}
              step={1}
              unit=" Hz"
              onChange={(v) => set({ baseFreq: v })}
              onCommit={() => play()}
            />
            <div>
              <KnobLabel className="mb-1.5 block">Pitch sweep</KnobLabel>
              <div className="flex gap-1.5 mt-1.5">
                {["none", "up", "down"].map((s) => (
                  <SegButton key={s} active={cfg.sweep === s} onClick={() => set({ sweep: s }, true)}>
                    {s}
                  </SegButton>
                ))}
              </div>
            </div>
            {cfg.sweep !== "none" && (
              <Slider
                label="Sweep amount"
                value={cfg.sweepAmount}
                min={0.05}
                max={0.8}
                step={0.01}
                unit=""
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => set({ sweepAmount: v })}
                onCommit={() => play()}
              />
            )}
          </Panel>

          <Panel title="Envelope">
            <Slider
              label="Note duration"
              value={cfg.duration}
              min={40}
              max={400}
              step={5}
              unit=" ms"
              onChange={(v) => set({ duration: v })}
              onCommit={() => play()}
            />
            <Slider
              label="Attack"
              value={cfg.attack}
              min={1}
              max={60}
              step={1}
              unit=" ms"
              onChange={(v) => set({ attack: v })}
              onCommit={() => play()}
            />
            <Slider
              label="Decay"
              value={cfg.decay}
              min={20}
              max={300}
              step={5}
              unit=" ms"
              onChange={(v) => set({ decay: v })}
              onCommit={() => play()}
            />
            {SHAPES[cfg.shape].semis.length > 1 && (
              <Slider
                label="Note spacing"
                value={cfg.noteInterval}
                min={40}
                max={260}
                step={5}
                unit=" ms"
                onChange={(v) => set({ noteInterval: v })}
                onCommit={() => play()}
              />
            )}
          </Panel>

          <Panel title="Output">
            <div>
              <div className="flex justify-between items-baseline mb-1.5">
                <KnobLabel>
                  <Volume2 size={11} className="inline mr-1 -mt-0.5" />
                  Volume
                </KnobLabel>
                <Readout>{Math.round(cfg.volume * 100)}%</Readout>
              </div>
              <input
                type="range"
                min={0.05}
                max={0.9}
                step={0.01}
                value={cfg.volume}
                onChange={(e) => set({ volume: parseFloat(e.target.value) })}
                onMouseUp={() => play()}
                onTouchEnd={() => play()}
                onKeyUp={() => play()}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                style={{ backgroundColor: COLORS.border, accentColor: COLORS.secondary }}
              />
            </div>
            <div className="text-[11px] font-mono pt-1 border-t" style={{ color: COLORS.textMuted, borderColor: COLORS.border }}>
              Total length: <span style={{ color: COLORS.accent }}>{totalDurationMs(cfg)}ms</span>
            </div>
          </Panel>
        </div>

        <p className="text-[11px] font-mono text-center mt-5 leading-relaxed" style={{ color: COLORS.textMuted }}>
          Download saves a .wav file. On Android, copy it into the Ringtones or<br />
          Notifications folder. On iPhone, import it into GarageBand to set as a ringtone.
        </p>
      </div>
    </div>
  );
}
