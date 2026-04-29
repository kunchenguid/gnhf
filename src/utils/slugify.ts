import { randomBytes } from "node:crypto";

export function slugifyPrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");

  const hash = randomBytes(3).toString("hex");

  return `gnhf/${slug}-${hash}`;
}
