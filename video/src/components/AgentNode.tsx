import { interpolate, useCurrentFrame } from "remotion";
import { fonts, palette } from "../theme";

/**
 * A single agent: glowing orb + monospace label. The main agent and every
 * clone are rendered with this — visually they are the *same* thing.
 */
export const AgentNode: React.FC<{
  label: string;
  sublabel?: string;
  size?: number;
  color?: string;
  pulse?: boolean;
  dim?: boolean;
}> = ({
  label,
  sublabel,
  size = 92,
  color = palette.neon,
  pulse = true,
  dim = false,
}) => {
  const frame = useCurrentFrame();
  const p = pulse
    ? interpolate(Math.sin(frame / 9), [-1, 1], [0.85, 1.12])
    : 1;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        opacity: dim ? 0.4 : 1,
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: `radial-gradient(circle at 38% 32%, #ffffff, ${color} 55%, ${palette.neonDeep} 100%)`,
          boxShadow: `0 0 ${28 * p}px ${color}, 0 0 ${70 * p}px ${color}66`,
          border: `2px solid ${palette.ice}`,
        }}
      />
      <div style={{ textAlign: "center", lineHeight: 1.2 }}>
        <div
          style={{
            fontFamily: fonts.mono,
            fontWeight: 700,
            fontSize: 26,
            color: palette.text,
            letterSpacing: 1,
          }}
        >
          {label}
        </div>
        {sublabel && (
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 17,
              color: palette.textDim,
            }}
          >
            {sublabel}
          </div>
        )}
      </div>
    </div>
  );
};
