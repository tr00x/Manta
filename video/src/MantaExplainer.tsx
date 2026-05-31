import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion";
import { scenes } from "./theme";
import { Hook } from "./scenes/Hook";
import { Problem } from "./scenes/Problem";
import { TheBet } from "./scenes/TheBet";
import { Parallel } from "./scenes/Parallel";
import { Lifecycle } from "./scenes/Lifecycle";
import { CTA } from "./scenes/CTA";

const FADE = 12;

/** Wraps a scene with a short fade-in/out so hard cuts read as soft dissolves. */
const SceneFade: React.FC<{ duration: number; children: React.ReactNode }> = ({
  duration,
  children,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [0, FADE, duration - FADE, duration],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

export const MantaExplainer: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#04060d" }}>
      <Sequence from={scenes.hook.from} durationInFrames={scenes.hook.durationInFrames}>
        <SceneFade duration={scenes.hook.durationInFrames}>
          <Hook />
        </SceneFade>
      </Sequence>
      <Sequence from={scenes.problem.from} durationInFrames={scenes.problem.durationInFrames}>
        <SceneFade duration={scenes.problem.durationInFrames}>
          <Problem />
        </SceneFade>
      </Sequence>
      <Sequence from={scenes.theBet.from} durationInFrames={scenes.theBet.durationInFrames}>
        <SceneFade duration={scenes.theBet.durationInFrames}>
          <TheBet />
        </SceneFade>
      </Sequence>
      <Sequence from={scenes.parallel.from} durationInFrames={scenes.parallel.durationInFrames}>
        <SceneFade duration={scenes.parallel.durationInFrames}>
          <Parallel />
        </SceneFade>
      </Sequence>
      <Sequence from={scenes.lifecycle.from} durationInFrames={scenes.lifecycle.durationInFrames}>
        <SceneFade duration={scenes.lifecycle.durationInFrames}>
          <Lifecycle />
        </SceneFade>
      </Sequence>
      <Sequence from={scenes.cta.from} durationInFrames={scenes.cta.durationInFrames}>
        <SceneFade duration={scenes.cta.durationInFrames}>
          <CTA />
        </SceneFade>
      </Sequence>
    </AbsoluteFill>
  );
};
