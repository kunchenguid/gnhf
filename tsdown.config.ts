import { defineConfig } from "tsdown";

const buildUmamiHost = process.env.GNHF_UMAMI_HOST ?? "";
const buildUmamiWebsiteID = process.env.GNHF_UMAMI_WEBSITE_ID ?? "";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node20",
  banner: "#!/usr/bin/env node",
  clean: true,
  outDir: "dist",
  dts: false,
  define: {
    __GNHF_UMAMI_HOST__: JSON.stringify(buildUmamiHost),
    __GNHF_UMAMI_WEBSITE_ID__: JSON.stringify(buildUmamiWebsiteID),
  },
});
