import { defineSandbox } from "eve/sandbox";
// Published package users should import from "@asciidev/eve-box".
// This repo example imports local source so `npm run build` works before `dist/` exists.
import { asciiBox } from "../../src/index.js";

export default defineSandbox({
  backend: asciiBox({
    apiKey: process.env.BOX_API_KEY!,
    ttlSeconds: 3600,
    networkPolicy: "allow-all",
  }),
});
