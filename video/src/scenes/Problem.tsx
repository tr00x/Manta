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

const Panel: React.FC<{
  title: string;
  children: React.ReactNode;
  delay: number;
}> = ({ title, children, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return (
    <div
      style={{
        width: 620,
        height: 420,
        background: palette.panel,
        border: `1px solid ${palette.panelEdge}`,
        borderRadius: 18,
        padding: 36,
        opacity: s,
        transform: `translateY(${interpolate(s, [0, 1], [40, 0])}px)`,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 20,
          color: palette.textDim,
          marginBottom: 24,
          letterSpacing: 1,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
};

export const Problem: React.FC = () => {
  const frame = useCurrentFrame();

  // CrewAI-style role graph nodes
  const roles = ["planner", "researcher", "coder", "writer"];

  return (
    <AbsoluteFill>
      <GridBG glow={palette.ember} />
      <AbsoluteFill
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 64,
        }}
      >
        <Panel title="// subagents" delay={6}>
          <div
            style={{
              fontFamily: fonts.sans,
              fontWeight: 800,
              fontSize: 40,
              color: palette.text,
              lineHeight: 1.2,
            }}
          >
            They start <span style={{ color: palette.ember }}>cold.</span>
          </div>
          <div
            style={{
              fontFamily: fonts.sans,
              fontSize: 26,
              color: palette.textDim,
              marginTop: 18,
              lineHeight: 1.4,
            }}
          >
            Fresh context. They don't know the hour you just spent figuring this
            out — so you re-explain, or they re-break it.
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ fontFamily: fonts.mono, fontSize: 60, opacity: 0.5 }}>
            🧊 ⟶ ❄️
          </div>
        </Panel>

        <Panel title="// crewai · autogpt · langgraph" delay={20}>
          <div
            style={{
              fontFamily: fonts.sans,
              fontWeight: 800,
              fontSize: 40,
              color: palette.text,
              lineHeight: 1.2,
            }}
          >
            They make you <span style={{ color: palette.amber }}>specialize.</span>
          </div>
          <div
            style={{
              fontFamily: fonts.sans,
              fontSize: 26,
              color: palette.textDim,
              marginTop: 18,
              lineHeight: 1.4,
            }}
          >
            Design a crew, wire the roles, maintain the graph — assumptions you
            bake in before you understand the problem.
          </div>
          <div style={{ flex: 1 }} />
          <svg width="540" height="90" style={{ alignSelf: "center" }}>
            {roles.map((r, i) => {
              const x = 60 + i * 140;
              const appear = interpolate(
                frame,
                [40 + i * 8, 56 + i * 8],
                [0, 1],
                { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
              );
              return (
                <g key={r} opacity={appear}>
                  {i < roles.length - 1 && (
                    <line
                      x1={x + 22}
                      y1={45}
                      x2={x + 118}
                      y2={45}
                      stroke={palette.amber}
                      strokeWidth={2}
                      strokeDasharray="4 6"
                    />
                  )}
                  <circle cx={x} cy={45} r={22} fill="#1a1505" stroke={palette.amber} strokeWidth={2} />
                  <text
                    x={x}
                    y={82}
                    fill={palette.textDim}
                    fontSize={14}
                    fontFamily={fonts.mono}
                    textAnchor="middle"
                  >
                    {r}
                  </text>
                </g>
              );
            })}
          </svg>
        </Panel>
      </AbsoluteFill>
      <Caption delay={90}>
        Parallelism, but you pay for it in <Hi c={palette.amber}>cold starts</Hi> and{" "}
        <Hi c={palette.amber}>role graphs.</Hi>
      </Caption>
    </AbsoluteFill>
  );
};
