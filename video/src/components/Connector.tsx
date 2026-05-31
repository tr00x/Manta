import { AbsoluteFill, useCurrentFrame } from "remotion";
import { palette } from "../theme";

export type Pt = { x: number; y: number };

/**
 * Animated bus link between two points — a dashed line with a packet of
 * energy flowing along it. Models clones coordinating over the Manta bus.
 */
export const Connector: React.FC<{
  from: Pt;
  to: Pt;
  color?: string;
  active?: boolean;
  width?: number;
}> = ({ from, to, color = palette.neon, active = true, width = 2 }) => {
  const frame = useCurrentFrame();
  const dash = (frame * 1.4) % 22;
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const t = (frame % 90) / 90;
  const px = from.x + (to.x - from.x) * t;
  const py = from.y + (to.y - from.y) * t;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <svg width="1920" height="1080" style={{ position: "absolute" }}>
        <line
          x1={from.x}
          y1={from.y}
          x2={to.x}
          y2={to.y}
          stroke={color}
          strokeWidth={width}
          strokeDasharray="6 16"
          strokeDashoffset={-dash}
          opacity={active ? 0.55 : 0.18}
          strokeLinecap="round"
        />
        {active && len > 1 && (
          <circle cx={px} cy={py} r={5} fill={palette.ice}>
          </circle>
        )}
      </svg>
    </AbsoluteFill>
  );
};
