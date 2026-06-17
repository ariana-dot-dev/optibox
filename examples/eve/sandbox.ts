import { defineSandbox } from "eve/sandbox";
import { asciiBox } from "../../src/index.js";

export default defineSandbox({
  backend: asciiBox({
    apiKey: process.env.BOX_API_KEY!,
    ttlSeconds: 3600,
    networkPolicy: "allow-all",
  }),
});
