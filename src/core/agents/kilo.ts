import type { ServeAgentDeps } from "./opencode.js";
import { ServeBasedAgent } from "./opencode.js";

export class KiloAgent extends ServeBasedAgent {
  name = "kilo";

  constructor(deps: ServeAgentDeps = {}) {
    super({ ...deps, name: "kilo" });
  }
}
