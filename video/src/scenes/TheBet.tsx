import {
  AbsoluteFill,
  interpolate,
  Easing,
  useCurrentFrame,
} from "remotion";
import { GridBG } from "../components/GridBG";
import { BladeRing } from "../components/BladeRing";
import { AgentNode } from "../components/AgentNode";
import { Caption, Hi } from "../components/Caption";
import { fonts, palette } from "../theme";

const FLASH = 96; // frame of Manta Style activation

export const TheBet: React.FC = () => {
  const frame = useCurrentFrame();

  // headline swap: "Don't specialize." -> "Clone."
  const out1 = interpolate(frame, [60, 84], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const in2 = interpolate(frame, [FLASH, FLASH + 24], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // charge then flash
  const charge = interpolate(frame, [40, FLASH], [1, 1.5], { extrapolateRight: "clamp" });
  const flash = interpolate(
    frame,
    [FLASH - 6, FLASH, FLASH + 18],
    [0, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.ease) },
  );

  // ring bursts out after the flash
  const spread = interpolate(frame, [FLASH, 220], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const ringOpacity = interpolate(frame, [FLASH, FLASH + 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const rotation = interpolate(frame, [FLASH, 360], [0, 50]);

  const clones = ["A", "B", "C", "D", "E", "F"];
  const ringRadius = 300;

  return (
    <AbsoluteFill>
      <GridBG />

      {/* headlines */}
      <div
        style={{
          position: "absolute",
          top: 140,
          width: "100%",
          textAlign: "center",
          fontFamily: fonts.sans,
          fontWeight: 800,
        }}
      >
        <div style={{ position: "absolute", width: "100%", opacity: out1, fontSize: 64, color: palette.textDim }}>
          Don't specialize.
        </div>
        <div style={{ position: "absolute", width: "100%", opacity: in2, fontSize: 96, color: palette.ice, letterSpacing: 2 }}>
          Clone.
        </div>
      </div>

      {/* the blade ring (Manta Style illusions) */}
      <BladeRing
        count={6}
        radius={ringRadius}
        bladeSize={130}
        rotation={rotation}
        spread={Math.max(0.001, spread)}
        glow={1}
        opacity={ringOpacity}
      />

      {/* clone labels on the inner radius, angle-matched to each blade */}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ position: "relative", width: 0, height: 0, transform: `rotate(${rotation}deg)` }}>
          {clones.map((c, i) => {
            const angle = (i / clones.length) * Math.PI * 2; // matches BladeRing
            const r = ringRadius * 0.52 * spread;
            const appear = interpolate(frame, [FLASH + 14 + i * 5, FLASH + 38 + i * 5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            return (
              <div
                key={c}
                style={{
                  position: "absolute",
                  left: Math.cos(angle) * r,
                  top: Math.sin(angle) * r,
                  transform: `translate(-50%,-50%) rotate(${-rotation}deg)`,
                  opacity: appear,
                  fontFamily: fonts.mono,
                  fontSize: 19,
                  fontWeight: 700,
                  color: palette.ice,
                  textShadow: `0 0 10px ${palette.neon}`,
                  whiteSpace: "nowrap",
                }}
              >
                clone {c}
              </div>
            );
          })}
        </div>
      </AbsoluteFill>

      {/* central main agent that spawns the rest */}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ transform: `scale(${charge})` }}>
          <AgentNode label={frame < FLASH ? "main" : ""} size={90} color={palette.ice} />
        </div>
      </AbsoluteFill>

      {/* Manta Style flash */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 50%, #ffffff ${flash * 40}%, ${palette.ice}00 ${flash * 90}%)`,
          opacity: flash,
          mixBlendMode: "screen",
        }}
      />

      <Caption delay={170} bottom={110} size={32}>
        The agent that already gets it — <Hi>forked.</Hi> Same system prompt, your
        full transcript, N copies.
      </Caption>
    </AbsoluteFill>
  );
};
