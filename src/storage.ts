import type { Conversation, Message } from "./types.js";

export interface ChatStorage {
  fetchConversations(): Promise<Conversation[]>;
  fetchConversation(id: string): Promise<Conversation | null>;
  createConversation(id: string, title: string): Promise<Conversation>;
  updateConversationTitle(id: string, title: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  fetchMessages(conversationId: string): Promise<Message[]>;
  addMessage(message: Message, conversationId: string): Promise<void>;
  updateMessageStatus(id: string, status: Message["status"]): Promise<void>;
  deleteMessage(id: string): Promise<void>;
}

export class InMemoryStorage implements ChatStorage {
  private conversations = new Map<string, Conversation>();
  private messages = new Map<string, Message[]>();

  async fetchConversations(): Promise<Conversation[]> {
    return Array.from(this.conversations.values()).sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async fetchConversation(id: string): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async createConversation(id: string, title: string): Promise<Conversation> {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id,
      title,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(id, conversation);
    this.messages.set(id, []);
    return conversation;
  }

  async updateConversationTitle(id: string, title: string): Promise<void> {
    const conv = this.conversations.get(id);
    if (conv) {
      conv.title = title;
      conv.updatedAt = new Date().toISOString();
    }
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
    this.messages.delete(id);
  }

  async fetchMessages(conversationId: string): Promise<Message[]> {
    return this.messages.get(conversationId) ?? [];
  }

  async addMessage(message: Message, conversationId: string): Promise<void> {
    const msgs = this.messages.get(conversationId) ?? [];
    msgs.push(message);
    this.messages.set(conversationId, msgs);

    const conv = this.conversations.get(conversationId);
    if (conv) {
      conv.messageCount = msgs.length;
      conv.updatedAt = new Date().toISOString();
    }
  }

  async updateMessageStatus(
    id: string,
    status: Message["status"],
  ): Promise<void> {
    for (const msgs of this.messages.values()) {
      const msg = msgs.find((m) => m.id === id);
      if (msg) {
        msg.status = status;
        return;
      }
    }
  }

  async deleteMessage(id: string): Promise<void> {
    for (const [convId, msgs] of this.messages.entries()) {
      const idx = msgs.findIndex((m) => m.id === id);
      if (idx !== -1) {
        msgs.splice(idx, 1);
        const conv = this.conversations.get(convId);
        if (conv) {
          conv.messageCount = msgs.length;
        }
        return;
      }
    }
  }
}
