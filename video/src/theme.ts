/**
 * Visual language for the Manta explainer.
 * Dark tech-minimalism keyed off the header art: near-black void,
 * ice-blue blade glow, deep-navy bodies, red-hot handle accents.
 */
export const palette = {
  void: "#04060d",
  panel: "#0a0f1c",
  panelEdge: "#16203a",
  grid: "#0e1626",

  ice: "#9bd6ff", // blade glow highlight
  neon: "#3b82f6", // primary accent / energy
  neonDeep: "#1d4ed8",
  ember: "#e0464e", // handle accents on the blades
  amber: "#f5a623",

  text: "#e8eef7",
  textDim: "#7486a0",
  textFaint: "#3d4a61",
  ok: "#4ade80",
} as const;

export const FPS = 30;

// Scene boundaries in frames (30fps). End of one == start of next.
export const scenes = {
  hook: { from: 0, durationInFrames: 240 }, // 0–8s
  problem: { from: 240, durationInFrames: 360 }, // 8–20s
  theBet: { from: 600, durationInFrames: 360 }, // 20–32s
  parallel: { from: 960, durationInFrames: 600 }, // 32–52s
  lifecycle: { from: 1560, durationInFrames: 480 }, // 52–68s
  cta: { from: 2040, durationInFrames: 360 }, // 68–80s
} as const;

export const TOTAL_FRAMES = 2400; // 80s @ 30fps

export const fonts = {
  sans: "Inter, system-ui, sans-serif",
  mono: "'Roboto Mono', ui-monospace, monospace",
} as const;
