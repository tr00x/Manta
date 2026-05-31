import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { GridBG } from "../components/GridBG";
import { Terminal } from "../components/Terminal";
import { AgentNode } from "../components/AgentNode";
import { Caption, Hi } from "../components/Caption";
import { palette } from "../theme";

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nodeIn = spring({ frame: frame - 10, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill>
      <GridBG />
      <AbsoluteFill
        style={{
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 56,
        }}
      >
        <div style={{ opacity: nodeIn, transform: `scale(${interpolate(nodeIn, [0, 1], [0.8, 1])})` }}>
          <AgentNode label="main" sublabel="your session" color={palette.neon} />
        </div>
        <Terminal
          title="claude-code — ~/project"
          width={920}
          startAt={30}
          cps={42}
          fps={fps}
          lines={[
            { text: "refactor auth across 14 files, add rate", prompt: true },
            { text: "limiting, then migrate the whole test suite", color: palette.text },
            { text: "", },
            { text: "…that's a long afternoon for one agent.", color: palette.textDim },
          ]}
        />
      </AbsoluteFill>
      <Caption delay={150}>
        One agent. A task that's <Hi>big, branchy, repetitive.</Hi>
      </Caption>
    </AbsoluteFill>
  );
};
