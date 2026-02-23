import { describe, it, expect } from "vitest";
import { InMemoryStorage } from "../src/storage.js";
import type { Message } from "../src/types.js";

describe("InMemoryStorage", () => {
  it("creates and fetches conversations", async () => {
    const storage = new InMemoryStorage();
    const conv = await storage.createConversation("c1", "Test Chat");

    expect(conv.id).toBe("c1");
    expect(conv.title).toBe("Test Chat");
    expect(conv.messageCount).toBe(0);

    const fetched = await storage.fetchConversation("c1");
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Test Chat");
  });

  it("returns null for non-existent conversation", async () => {
    const storage = new InMemoryStorage();
    const result = await storage.fetchConversation("nope");
    expect(result).toBeNull();
  });

  it("lists conversations sorted by updatedAt desc", async () => {
    const storage = new InMemoryStorage();
    await storage.createConversation("c1", "First");

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await storage.createConversation("c2", "Second");

    const convos = await storage.fetchConversations();
    expect(convos[0]!.id).toBe("c2");
    expect(convos[1]!.id).toBe("c1");
  });

  it("updates conversation title", async () => {
    const storage = new InMemoryStorage();
    await storage.createConversation("c1", "Old Title");
    await storage.updateConversationTitle("c1", "New Title");

    const conv = await storage.fetchConversation("c1");
    expect(conv!.title).toBe("New Title");
  });

  it("deletes conversation and its messages", async () => {
    const storage = new InMemoryStorage();
    await storage.createConversation("c1", "Delete Me");
    const msg: Message = {
      id: "m1",
      conversationId: "c1",
      role: "user",
      content: "Hello",
      status: "complete",
      createdAt: new Date().toISOString(),
    };
    await storage.addMessage(msg, "c1");

    await storage.deleteConversation("c1");

    expect(await storage.fetchConversation("c1")).toBeNull();
    expect(await storage.fetchMessages("c1")).toHaveLength(0);
  });

  it("adds and fetches messages", async () => {
    const storage = new InMemoryStorage();
    await storage.createConversation("c1", "Chat");

    const msg: Message = {
      id: "m1",
      conversationId: "c1",
      role: "user",
      content: "Hello",
      status: "complete",
      createdAt: new Date().toISOString(),
    };
    await storage.addMessage(msg, "c1");

    const messages = await storage.fetchMessages("c1");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("Hello");

    // Message count should be updated
    const conv = await storage.fetchConversation("c1");
    expect(conv!.messageCount).toBe(1);
  });

  it("updates message status", async () => {
    const storage = new InMemoryStorage();
    await storage.createConversation("c1", "Chat");

    const msg: Message = {
      id: "m1",
      conversationId: "c1",
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: new Date().toISOString(),
    };
    await storage.addMessage(msg, "c1");
    await storage.updateMessageStatus("m1", "complete");

    const messages = await storage.fetchMessages("c1");
    expect(messages[0]!.status).toBe("complete");
  });

  it("deletes a message", async () => {
    const storage = new InMemoryStorage();
    await storage.createConversation("c1", "Chat");

    const msg: Message = {
      id: "m1",
      conversationId: "c1",
      role: "user",
      content: "Hello",
      status: "complete",
      createdAt: new Date().toISOString(),
    };
    await storage.addMessage(msg, "c1");
    await storage.deleteMessage("m1");

    const messages = await storage.fetchMessages("c1");
    expect(messages).toHaveLength(0);

    const conv = await storage.fetchConversation("c1");
    expect(conv!.messageCount).toBe(0);
  });
});
