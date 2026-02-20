import { ChatSession } from "@astralform/js";

const session = new ChatSession({
  apiKey: "your-api-key",
  userId: "user-123",
  // baseURL: "http://localhost:8000", // for local development
});

// Subscribe to events
session.on((event) => {
  switch (event.type) {
    case "connected":
      console.log("Connected to Astralform");
      break;
    case "chunk":
      process.stdout.write(event.text);
      break;
    case "complete":
      console.log("\n\nDone! Conversation:", event.conversationId);
      break;
    case "error":
      console.error("Error:", event.error.message);
      break;
  }
});

// Connect and send a message
await session.connect();
await session.send("What is the capital of France?");

// Clean up
session.disconnect();
