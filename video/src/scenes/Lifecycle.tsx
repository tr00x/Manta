import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { GridBG } from "../components/GridBG";
import { Caption, Hi } from "../components/Caption";
import { fonts, palette } from "../theme";

const Gate: React.FC<{ label: string; ok: boolean; show: number }> = ({ label, ok, show }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [show, show + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <span
      style={{
        fontFamily: fonts.mono,
        fontSize: 18,
        color: ok ? palette.ok : palette.ember,
        opacity: o,
        marginRight: 18,
      }}
    >
      {ok ? "✓" : "✗"} {label}
    </span>
  );
};

const BranchRow: React.FC<{
  name: string;
  y: number;
  winner?: boolean;
  delay: number;
}> = ({ name, y, winner, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  const dots = [0, 1, 2];
  return (
    <g opacity={s} transform={`translate(0 ${y})`}>
      <line x1={40} y1={0} x2={520} y2={0} stroke={palette.panelEdge} strokeWidth={3} />
      {dots.map((d) => {
        const cx = 120 + d * 140;
        const appear = interpolate(frame, [delay + 10 + d * 8, delay + 22 + d * 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return (
          <circle key={d} cx={cx} cy={0} r={9} fill={winner ? palette.ice : palette.neon} opacity={appear}
            style={{ filter: `drop-shadow(0 0 6px ${winner ? palette.ice : palette.neon})` }} />
        );
      })}
      <text x={528} y={6} fill={winner ? palette.ice : palette.textDim} fontSize={18} fontFamily={fonts.mono}>
        {name}{winner ? "  ◀ winner" : ""}
      </text>
    </g>
  );
};

export const Lifecycle: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cardIn = spring({ frame: frame - 200, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill>
      <GridBG glow={palette.ok} />

      <div
        style={{
          position: "absolute",
          top: 90,
          width: "100%",
          textAlign: "center",
          fontFamily: fonts.sans,
          fontWeight: 800,
          fontSize: 44,
          color: palette.text,
        }}
      >
        Commit · score · merge
      </div>

      <AbsoluteFill style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 70 }}>
        {/* branch graph */}
        <svg width="760" height="360">
          <BranchRow name="cast-7f/A" y={70} winner delay={10} />
          <BranchRow name="cast-7f/B" y={180} delay={26} />
          <BranchRow name="cast-7f/C" y={290} delay={42} />
        </svg>

        {/* merge-review card */}
        <div
          style={{
            width: 560,
            background: palette.panel,
            border: `1px solid ${palette.panelEdge}`,
            borderRadius: 18,
            padding: 34,
            opacity: cardIn,
            transform: `translateY(${interpolate(cardIn, [0, 1], [40, 0])}px)`,
            boxShadow: `0 0 0 1px ${palette.ok}22, 0 24px 80px #000a`,
          }}
        >
          <div style={{ fontFamily: fonts.mono, fontSize: 18, color: palette.textDim, marginBottom: 6 }}>
            docs/merge-reviews/cast-7f.md
          </div>
          <div style={{ fontFamily: fonts.sans, fontWeight: 800, fontSize: 30, color: palette.text, marginBottom: 22 }}>
            merge-review
          </div>
          <div style={{ marginBottom: 10 }}>
            <Gate label="typecheck" ok show={230} />
            <Gate label="lint" ok show={245} />
            <Gate label="test" ok show={260} />
          </div>
          <div style={{ height: 1, background: palette.panelEdge, margin: "20px 0" }} />
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 22,
              color: palette.ok,
              opacity: interpolate(frame, [300, 320], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }}
          >
            verdict: merge A
          </div>
          <div
            style={{
              fontFamily: fonts.sans,
              fontSize: 19,
              color: palette.textDim,
              marginTop: 8,
              opacity: interpolate(frame, [312, 332], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }}
          >
            cleanest diff, fully gated · cherry-pick B's fixtures
          </div>
        </div>
      </AbsoluteFill>

      {frame < 200 ? (
        <Caption delay={60} bottom={90} size={30}>
          Clones commit to their <Hi>own branches.</Hi> No clone pushes — the main
          agent pulls.
        </Caption>
      ) : (
        <Caption delay={205} bottom={90} size={30}>
          Manta <Hi c={palette.ok}>gate-scores</Hi> the branches and writes a
          verdict. You merge the winner.
        </Caption>
      )}
    </AbsoluteFill>
  );
};
