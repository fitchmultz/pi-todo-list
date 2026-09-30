import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Match Posthorse's public in-run boundary without replacing host execution or projection.
export default function retainNone(pi: ExtensionAPI): void {
  pi.on("turn_end", (event) => {
    if (event.message.role !== "assistant" || !event.message.content.some((part) =>
      part.type === "toolCall" && part.name === "todo_list" && part.arguments.text === "CURRENT boundary task")) return;
    return {
      entries: [...event.entries, { type: "compaction", summary: "", firstKeptEntryId: null }],
      continue: true,
    };
  });
}
