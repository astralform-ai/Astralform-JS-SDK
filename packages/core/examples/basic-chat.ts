import { ChatSession } from "@astralform/js";

const session = new ChatSession({
  apiKey: "your-api-key",
  userId: "user-123",
  // baseURL: "http://localhost:8000", // for local development
});

session.on((event) => {
  switch (event.type) {
    case "connected":
      console.log("Connected to Astralform");
      break;
    case "block_delta":
      if (event.delta.channel === "text") {
        process.stdout.write(event.delta.text);
      }
      break;
    case "message_stop":
      console.log(
        `\n\nDone — ${event.usage.outputTokens} output tokens in ${event.totalMs}ms`,
      );
      break;
    case "error":
      console.error(`Error (${event.code}): ${event.message}`);
      break;
  }
});

await session.connect();
await session.send("What is the capital of France?");

session.disconnect();
