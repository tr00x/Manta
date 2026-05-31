import { palette } from "../theme";

/**
 * Stylized Manta Style blade — the crescent-with-handle motif from the
 * header art. Drawn small and reused: single glyph, the ring composes many.
 */
export const Blade: React.FC<{
  size?: number;
  glow?: number; // 0..1 outer aura strength
  opacity?: number;
}> = ({ size = 120, glow = 1, opacity = 1 }) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      style={{ opacity, overflow: "visible" }}
    >
      <defs>
        <radialGradient id="bladeFill" cx="40%" cy="35%" r="75%">
          <stop offset="0%" stopColor="#eaf6ff" />
          <stop offset="55%" stopColor={palette.ice} />
          <stop offset="100%" stopColor={palette.neonDeep} />
        </radialGradient>
        <linearGradient id="handle" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0a1430" />
          <stop offset="100%" stopColor="#1b2b55" />
        </linearGradient>
      </defs>
      {/* crescent blade */}
      <path
        d="M50 6
           C24 6 6 26 6 52
           C6 74 22 92 44 95
           C30 84 24 68 28 52
           C33 33 49 22 70 26
           C63 13 57 6 50 6 Z"
        fill="url(#bladeFill)"
        stroke="#dff1ff"
        strokeWidth={1.2}
        style={{
          filter: glow
            ? `drop-shadow(0 0 ${10 * glow}px ${palette.ice}) drop-shadow(0 0 ${
                26 * glow
              }px ${palette.neon})`
            : undefined,
        }}
      />
      {/* handle / hilt with ember accents */}
      <rect
        x="46"
        y="44"
        width="9"
        height="44"
        rx="4"
        transform="rotate(-32 50 66)"
        fill="url(#handle)"
        stroke={palette.ice}
        strokeWidth={0.8}
      />
      <rect
        x="47"
        y="58"
        width="7"
        height="4"
        transform="rotate(-32 50 66)"
        fill={palette.ember}
      />
    </svg>
  );
};
