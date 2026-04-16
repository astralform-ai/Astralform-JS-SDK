/**
 * Multi-Agent Demo — Node.js CLI
 *
 * Connects to a multi-agent Astralform project and logs the v2 event
 * surface with formatted output.
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

session.on((event: ChatEvent) => {
  switch (event.type) {
    case "connected":
      console.log("\n--- Connected ---");
      console.log(
        `Agents: ${session.agents.map((a) => a.displayName).join(", ") || "none"}`,
      );
      break;

    case "message_start":
      console.log(
        `\n[turn ${event.turnId}] ${event.agentDisplayName ?? event.agentName ?? "agent"} (model: ${event.model})`,
      );
      break;

    case "subagent_start":
      console.log(
        `\n[subagent:${event.agent.displayName ?? event.agent.name}] delegated (${event.agent.description ?? "no description"})`,
      );
      break;

    case "subagent_stop":
      console.log(
        `[subagent:${event.agent.displayName ?? event.agent.name}] done`,
      );
      break;

    case "block_start":
      if (event.kind === "thinking") {
        process.stdout.write("\n[thinking] ");
      } else if (event.kind === "tool_use") {
        const fn = event.metadata.function as { name?: string } | undefined;
        console.log(`\n[tool] ${fn?.name ?? "(unknown)"}`);
      }
      break;

    case "block_delta":
      if (event.delta.channel === "text") {
        process.stdout.write(event.delta.text);
      } else if (event.delta.channel === "thinking") {
        process.stdout.write(event.delta.text);
      } else if (event.delta.channel === "output") {
        // Shell / interpreter streams (stdout / stderr / progress).
        process.stdout.write(event.delta.chunk);
      }
      break;

    case "block_stop":
      if (event.status === "awaiting_client_result") {
        const toolName = event.final.tool_name as string | undefined;
        console.log(`\n[client tool ready] ${toolName ?? "(unknown)"}`);
      }
      break;

    case "todo_update": {
      const done = event.todos.filter((t) => t.status === "completed").length;
      console.log(`\n[todos] ${done}/${event.todos.length} complete`);
      for (const t of event.todos) {
        console.log(`  [${t.status}] ${t.subject}`);
      }
      break;
    }

    case "tool_approval_requested":
      console.log(
        `\n[approval needed] ${event.toolName} (risk=${event.riskLevel ?? "unknown"})`,
      );
      break;

    case "message_stop":
      console.log(
        `\n\n[done] reason=${event.stopReason} · ${event.usage.outputTokens} out / ${event.usage.inputTokens} in · ${event.totalMs}ms`,
      );
      break;

    case "error":
      console.error(`\n[error ${event.code}] ${event.message}`);
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
