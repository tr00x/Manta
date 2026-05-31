import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fonts, palette } from "../theme";

/** Lower-third caption that springs up and fades. */
export const Caption: React.FC<{
  children: React.ReactNode;
  delay?: number;
  bottom?: number;
  size?: number;
  color?: string;
}> = ({ children, delay = 0, bottom = 120, size = 34, color = palette.text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  const y = interpolate(enter, [0, 1], [30, 0]);

  return (
    <div
      style={{
        position: "absolute",
        bottom,
        left: 0,
        right: 0,
        textAlign: "center",
        transform: `translateY(${y}px)`,
        opacity: enter,
        padding: "0 140px",
      }}
    >
      <span
        style={{
          fontFamily: fonts.sans,
          fontWeight: 600,
          fontSize: size,
          color,
          letterSpacing: 0.2,
          lineHeight: 1.35,
        }}
      >
        {children}
      </span>
    </div>
  );
};

/** Inline accent for a word inside a caption. */
export const Hi: React.FC<{ children: React.ReactNode; c?: string }> = ({
  children,
  c = palette.ice,
}) => <span style={{ color: c, fontWeight: 800 }}>{children}</span>;
