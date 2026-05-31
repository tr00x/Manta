import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { GridBG } from "../components/GridBG";
import { BladeRing } from "../components/BladeRing";
import { fonts, palette } from "../theme";

export const CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rot = interpolate(frame, [0, 360], [0, 60]);
  const title = spring({ frame: frame - 20, fps, config: { damping: 200 } });
  const tag = spring({ frame: frame - 50, fps, config: { damping: 200 } });
  const cmd = spring({ frame: frame - 90, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill>
      <GridBG />
      <BladeRing count={6} radius={380} bladeSize={170} rotation={rot} glow={1} opacity={0.9} />

      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 26 }}>
        <div
          style={{
            fontFamily: fonts.sans,
            fontWeight: 800,
            fontSize: 120,
            color: palette.text,
            letterSpacing: 4,
            opacity: title,
            transform: `scale(${interpolate(title, [0, 1], [0.85, 1])})`,
            textShadow: `0 0 50px ${palette.neon}88`,
          }}
        >
          Manta
        </div>
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 30,
            color: palette.ice,
            opacity: tag,
            maxWidth: 760,
            textAlign: "center",
            lineHeight: 1.4,
          }}
        >
          A clone is just <i>you</i>, again, somewhere else.
        </div>

        <div
          style={{
            marginTop: 22,
            fontFamily: fonts.mono,
            fontSize: 24,
            color: palette.text,
            background: palette.panel,
            border: `1px solid ${palette.panelEdge}`,
            borderRadius: 12,
            padding: "16px 26px",
            opacity: cmd,
            boxShadow: `0 0 0 1px ${palette.neon}33`,
          }}
        >
          <span style={{ color: palette.ok }}>❯ </span>
          manta cast forking-realities --clones 3
        </div>
        <div style={{ fontFamily: fonts.mono, fontSize: 20, color: palette.textDim, opacity: cmd }}>
          github.com/tr00x/Manta
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
