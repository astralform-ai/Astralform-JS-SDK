/**
 * Multi-Agent Demo — Node.js CLI
 *
 * Demonstrates connecting to a multi-agent Astralform project and
 * logging all event types with formatted output.
 *
 * Usage:
 *   npx tsx with-agents.ts
 *
 * Environment:
 *   ASTRALFORM_API_KEY — Your project API key
 *   ASTRALFORM_BASE_URL — (optional) API endpoint, defaults to https://api.astralform.ai
 */

import { ChatSession, type ChatEvent } from "@astralform/js";

const API_KEY = process.env.ASTRALFORM_API_KEY;
const BASE_URL = process.env.ASTRALFORM_BASE_URL ?? "https://api.astralform.ai";

if (!API_KEY) {
  console.error("Set ASTRALFORM_API_KEY environment variable");
  process.exit(1);
}

const session = new ChatSession({
  apiKey: API_KEY,
  baseURL: BASE_URL,
  userId: "demo-user",
});

// Format and log each event type
session.on((event: ChatEvent) => {
  switch (event.type) {
    case "connected":
      console.log("\n--- Connected ---");
      console.log(
        `Agents: ${session.agents.map((a) => a.displayName).join(", ") || "none"}`,
      );
      break;

    case "model_info":
      console.log(`[model] ${event.name}`);
      break;

    case "agent_start":
      console.log(
        `\n[agent:${event.agentDisplayName ?? event.agentName}] started`,
      );
      break;

    case "agent_end":
      console.log(`[agent:${event.agentName}] ended`);
      break;

    case "thinking_delta":
      process.stdout.write(`[thinking] ${event.text}`);
      break;

    case "thinking_complete":
      console.log("\n[thinking] complete");
      break;

    case "subagent_start":
      console.log(
        `\n[subagent:${event.displayName}] delegated (${event.description ?? "no description"})`,
      );
      break;

    case "subagent_chunk":
      process.stdout.write(event.text);
      break;

    case "subagent_end":
      console.log(`\n[subagent:${event.displayName}] done`);
      break;

    case "tool_call":
      console.log(
        `[tool:${event.request.toolName}] calling with ${JSON.stringify(event.request.arguments)}`,
      );
      break;

    case "tool_executing":
      console.log(`[tool:${event.name}] executing...`);
      break;

    case "tool_completed":
      console.log(
        `[tool:${event.name}] completed: ${event.result.slice(0, 100)}`,
      );
      break;

    case "tool_end":
      console.log(`[tool:${event.toolName}] end`);
      break;

    case "capsule_output":
      console.log(`\n[capsule:${event.toolName}] ${event.command ?? ""}`);
      console.log(event.output.slice(0, 200));
      if (event.durationMs) console.log(`  (${event.durationMs}ms)`);
      break;

    case "sources":
      console.log(`\n[sources] ${event.sources.length} sources:`);
      for (const s of event.sources) {
        console.log(`  - ${s.title}: ${s.url}`);
      }
      break;

    case "todo_update":
      const done = event.todos.filter((t) => t.completed).length;
      console.log(`[todos] ${done}/${event.todos.length} complete`);
      break;

    case "chunk":
      process.stdout.write(event.text);
      break;

    case "complete":
      console.log(
        `\n\n--- Complete (conversation: ${event.conversationId}) ---`,
      );
      break;

    case "error":
      console.error(`\n[error] ${event.error.message}`);
      break;

    case "disconnected":
      console.log("[disconnected]");
      break;
  }
});

async function main() {
  console.log("Connecting...");
  await session.connect();

  const message =
    process.argv[2] ??
    "Research the latest AI agent frameworks and compare their approaches.";
  console.log(`\nSending: "${message}"\n`);
  await session.send(message);

  session.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
