import { Composition } from "remotion";
import { MantaExplainer } from "./MantaExplainer";
import { FPS, TOTAL_FRAMES } from "./theme";
import "./fonts";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="MantaExplainer"
      component={MantaExplainer}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
    />
  );
};
