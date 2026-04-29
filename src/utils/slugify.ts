import { createHash } from "node:crypto";

export function slugifyPrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");

  const hash = createHash("sha256").update(prompt).digest("hex").slice(0, 6);

  return `gnhf/${slug}-${hash}`;
}
