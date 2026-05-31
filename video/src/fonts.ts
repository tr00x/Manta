import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/RobotoMono";

// Loaded at module import so every scene shares the same faces.
loadInter("normal", { weights: ["400", "600", "800"] });
loadMono("normal", { weights: ["400", "500", "700"] });
