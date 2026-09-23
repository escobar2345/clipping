import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

// Entry point used by @remotion/bundler when rendering via /api/render.
registerRoot(RemotionRoot);
