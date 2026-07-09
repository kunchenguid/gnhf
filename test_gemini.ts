import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn("gemini", ["-y", "-o", "stream-json", "-p", "run ls then echo done"]);
const rl = createInterface({ input: child.stdout });

rl.on("line", (line) => {
  console.log(line);
});
