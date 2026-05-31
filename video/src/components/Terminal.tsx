import { useCurrentFrame } from "remotion";
import { fonts, palette } from "../theme";

export type Line = { text: string; color?: string; prompt?: boolean };

/**
 * Terminal panel whose lines type out character-by-character, gated on the
 * local frame. `startAt` / `cps` (chars per second) control pacing.
 */
export const Terminal: React.FC<{
  title?: string;
  lines: Line[];
  width?: number;
  startAt?: number;
  cps?: number;
  fps?: number;
}> = ({
  title = "claude-code",
  lines,
  width = 720,
  startAt = 0,
  cps = 38,
  fps = 30,
}) => {
  const frame = useCurrentFrame();
  const elapsed = Math.max(0, frame - startAt);
  let budget = (elapsed / fps) * cps; // characters allowed so far

  return (
    <div
      style={{
        width,
        background: palette.panel,
        border: `1px solid ${palette.panelEdge}`,
        borderRadius: 14,
        boxShadow: `0 24px 80px #000a, 0 0 0 1px ${palette.neon}22`,
        overflow: "hidden",
        fontFamily: fonts.mono,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 16px",
          background: "#070b16",
          borderBottom: `1px solid ${palette.panelEdge}`,
        }}
      >
        <Dot c="#ff5f56" />
        <Dot c="#ffbd2e" />
        <Dot c="#27c93f" />
        <span
          style={{
            marginLeft: 10,
            color: palette.textDim,
            fontSize: 16,
          }}
        >
          {title}
        </span>
      </div>
      <div style={{ padding: "20px 22px", fontSize: 21, lineHeight: 1.7 }}>
        {lines.map((ln, i) => {
          const shown = Math.max(0, Math.min(ln.text.length, Math.floor(budget)));
          budget -= ln.text.length;
          const visible = ln.text.slice(0, shown);
          const typing = shown > 0 && shown < ln.text.length;
          if (shown <= 0 && budget < 0) return <div key={i}>&nbsp;</div>;
          return (
            <div key={i} style={{ color: ln.color ?? palette.text }}>
              {ln.prompt && <span style={{ color: palette.ok }}>❯ </span>}
              {visible}
              {typing && <Caret />}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Dot: React.FC<{ c: string }> = ({ c }) => (
  <span
    style={{ width: 12, height: 12, borderRadius: "50%", background: c }}
  />
);

const Caret: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <span
      style={{
        opacity: Math.floor(frame / 8) % 2 ? 0.15 : 1,
        color: palette.ice,
      }}
    >
      ▊
    </span>
  );
};
