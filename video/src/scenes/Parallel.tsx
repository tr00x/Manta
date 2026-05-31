import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { GridBG } from "../components/GridBG";
import { AgentNode } from "../components/AgentNode";
import { Terminal, Line } from "../components/Terminal";
import { Connector, Pt } from "../components/Connector";
import { Caption, Hi } from "../components/Caption";
import { fonts, palette } from "../theme";

type Station = {
  label: string;
  branch: string;
  at: Pt;
  lines: Line[];
};

const STATIONS: Station[] = [
  {
    label: "clone A",
    branch: "manta/cast-7f/A",
    at: { x: 360, y: 560 },
    lines: [
      { text: "lock packages/api/limiter.ts ✓", color: palette.ok },
      { text: "write token-bucket limiter…", color: palette.text },
      { text: "tests: 18 passed", color: palette.ok },
      { text: "commit a1f9c2", color: palette.ice },
    ],
  },
  {
    label: "clone B",
    branch: "manta/cast-7f/B",
    at: { x: 960, y: 600 },
    lines: [
      { text: "claim: migrate test suite", color: palette.amber },
      { text: "lock tests/auth.spec.ts ✓", color: palette.ok },
      { text: "port 41 fixtures…", color: palette.text },
      { text: "commit 7b30de", color: palette.ice },
    ],
  },
  {
    label: "clone C",
    branch: "manta/cast-7f/C",
    at: { x: 1560, y: 560 },
    lines: [
      { text: "lock packages/auth/*.ts ✓", color: palette.ok },
      { text: "refactor 14 call-sites…", color: palette.text },
      { text: "broadcast: api shape ↑", color: palette.neon },
      { text: "commit c0ee14", color: palette.ice },
    ],
  },
];

const MAIN: Pt = { x: 960, y: 175 };

export const Parallel: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const captionPhase = frame < 200 ? 0 : frame < 400 ? 1 : 2;

  return (
    <AbsoluteFill>
      <GridBG />

      {/* bus links: main → clones, and clone ↔ clone */}
      <Connector from={MAIN} to={STATIONS[0].at} active={frame > 30} />
      <Connector from={MAIN} to={STATIONS[1].at} active={frame > 40} />
      <Connector from={MAIN} to={STATIONS[2].at} active={frame > 50} />
      <Connector from={STATIONS[0].at} to={STATIONS[1].at} color={palette.ice} active={frame > 180} />
      <Connector from={STATIONS[1].at} to={STATIONS[2].at} color={palette.ice} active={frame > 220} />

      {/* main agent watching */}
      <div style={{ position: "absolute", left: MAIN.x, top: MAIN.y, transform: "translate(-50%,-50%)" }}>
        <AgentNode label="main" sublabel="reviews · merges" size={72} color={palette.ice} />
      </div>

      {/* clone stations */}
      {STATIONS.map((st, i) => {
        const enter = spring({ frame: frame - 20 - i * 10, fps, config: { damping: 200 } });
        return (
          <div
            key={st.label}
            style={{
              position: "absolute",
              left: st.at.x,
              top: st.at.y,
              transform: `translate(-50%,-50%) scale(${interpolate(enter, [0, 1], [0.8, 1])})`,
              opacity: enter,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              width: 460,
            }}
          >
            <AgentNode label={st.label} size={58} color={palette.neon} />
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 16,
                color: palette.textDim,
                padding: "4px 12px",
                border: `1px solid ${palette.panelEdge}`,
                borderRadius: 8,
                background: palette.panel,
              }}
            >
              ⌥ worktree · {st.branch}
            </div>
            <Terminal
              title={st.branch}
              width={460}
              startAt={30 + i * 14}
              cps={26}
              fps={fps}
              lines={st.lines}
            />
          </div>
        );
      })}

      {captionPhase === 0 && (
        <Caption delay={20} bottom={70} size={30}>
          Each clone gets its <Hi>own git worktree</Hi> — real isolation, its own
          branch.
        </Caption>
      )}
      {captionPhase === 1 && (
        <Caption delay={205} bottom={70} size={30}>
          They take <Hi>file locks</Hi>, claim work, and <Hi>broadcast</Hi> over the
          bus — coordination, not collision.
        </Caption>
      )}
      {captionPhase === 2 && (
        <Caption delay={405} bottom={70} size={30}>
          Warm start, no re-explaining. They <Hi>write code, run tests, commit</Hi>{" "}
          — in parallel.
        </Caption>
      )}
    </AbsoluteFill>
  );
};
