import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { palette } from "../theme";

/**
 * Shared backdrop: deep void + faint drifting tech grid + center vignette.
 * Every scene sits on this so cuts feel like one continuous space.
 */
export const GridBG: React.FC<{ glow?: string }> = ({ glow = palette.neon }) => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 600], [0, 40]) % 80;

  return (
    <AbsoluteFill style={{ backgroundColor: palette.void }}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${palette.grid} 1px, transparent 1px),
            linear-gradient(90deg, ${palette.grid} 1px, transparent 1px)`,
          backgroundSize: "80px 80px",
          backgroundPosition: `${drift}px ${drift}px`,
          opacity: 0.5,
          maskImage:
            "radial-gradient(ellipse 70% 70% at 50% 50%, black 30%, transparent 80%)",
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 60% 50% at 50% 45%, ${glow}22 0%, transparent 60%)`,
        }}
      />
      <AbsoluteFill
        style={{
          boxShadow: `inset 0 0 320px 80px ${palette.void}`,
        }}
      />
    </AbsoluteFill>
  );
};
