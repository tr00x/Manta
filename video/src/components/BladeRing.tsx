import { Blade } from "./Blade";

/**
 * The signature image: N blades arranged in a rotating ring (Manta Style
 * illusions). Used at the clone moment and the CTA.
 */
export const BladeRing: React.FC<{
  count?: number;
  radius?: number;
  bladeSize?: number;
  rotation?: number; // degrees
  spread?: number; // 0..1 — how far blades sit from center (for the burst-out)
  glow?: number;
  opacity?: number;
}> = ({
  count = 6,
  radius = 240,
  bladeSize = 150,
  rotation = 0,
  spread = 1,
  glow = 1,
  opacity = 1,
}) => {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity,
      }}
    >
      <div
        style={{
          position: "relative",
          width: 0,
          height: 0,
          transform: `rotate(${rotation}deg)`,
        }}
      >
        {Array.from({ length: count }).map((_, i) => {
          const angle = (i / count) * Math.PI * 2;
          const r = radius * spread;
          const x = Math.cos(angle) * r;
          const y = Math.sin(angle) * r;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: x,
                top: y,
                transform: `translate(-50%, -50%) rotate(${
                  (angle * 180) / Math.PI + 90
                }deg)`,
              }}
            >
              <Blade size={bladeSize} glow={glow} />
            </div>
          );
        })}
      </div>
    </div>
  );
};
