import type { Recapper, TranscriptMessage } from "./types.js";

export class ExtractiveRecapper implements Recapper {
  async recap(messages: TranscriptMessage[]): Promise<string> {
    const lines = messages.slice(-24).map((m) => `${m.role.toUpperCase()}${m.mode ? ` [${m.mode}]` : ""}: ${m.content.replace(/\s+/g, " ").trim()}`);
    return [
      "Conversation recap for Box handoff:",
      "- The shared prewarm agent was restricted to conversation/search only and could not inspect or mutate the machine.",
      "- Continue seamlessly from the latest user intent; do not repeat setup unless needed.",
      "",
      ...lines,
    ].join("\n");
  }
}
