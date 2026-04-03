/**
 * BlockBuilder — pure rendering engine. Zero default behavior.
 *
 * Clients register handlers that map events to blocks.
 * Both live streaming and restore go through the same engine.
 *
 *   import { BlockBuilder, standardHandlers } from "@astralform/js";
 *   const builder = new BlockBuilder();
 *   builder.registerHandlers(standardHandlers);
 */

import type { ChatEvent } from "./types.js";

// =============================================================================
// Block protocol — typed discriminated union
// =============================================================================

export interface UserBlock {
  type: "user";
  id: string;
  content: string;
  createdAt?: number;
}

export interface TextBlock {
  type: "text";
  id: string;
  content: string;
  isStreaming: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  id: string;
  content: string;
  isActive: boolean;
  durationMs?: number;
}

export interface AgentBlock {
  type: "agent";
  id: string;
  agentName: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface SubagentBlock {
  type: "subagent";
  id: string;
  agentName: string;
  displayName: string;
  toolCallId: string;
  avatarUrl?: string;
  description?: string;
  content: string;
  isActive: boolean;
}

export interface ToolBlock {
  type: "tool";
  id: string;
  callId: string;
  toolName: string;
  displayName?: string;
  description?: string;
  arguments?: Record<string, unknown>;
  status: string;
  iconUrl?: string;
  toolCategory?: string;
  sources?: { title: string; url: string; snippet?: string }[];
  durationMs?: number;
  result?: string;
}

export interface CapsuleBlock {
  type: "capsule";
  id: string;
  callId: string;
  toolName: string;
  command?: string;
  output: string;
  durationMs?: number;
  isActive: boolean;
}

export interface AssetBlock {
  type: "asset";
  id: string;
  assetId: string;
  name: string;
  url: string;
  mediaType: string;
  sizeBytes: number;
}

export interface TodoBlock {
  type: "todo";
  id: string;
  todos: { content: string; status: string }[];
}

export interface EditorBlock {
  type: "editor";
  id: string;
  callId: string;
  path: string;
  language: string;
  content: string;
  isStreaming: boolean;
}

export interface ErrorBlock {
  type: "error";
  id: string;
  message: string;
}

export interface DesktopStreamBlock {
  type: "desktop_stream";
  id: string;
  url: string;
  authKey: string;
  sandboxId: string;
}

export interface AttachmentBlock {
  type: "attachment";
  id: string;
  files: { name: string; path: string; mediaType: string; sizeBytes: number }[];
}

export type Block =
  | UserBlock
  | TextBlock
  | ThinkingBlock
  | AgentBlock
  | SubagentBlock
  | ToolBlock
  | CapsuleBlock
  | AssetBlock
  | TodoBlock
  | EditorBlock
  | DesktopStreamBlock
  | AttachmentBlock
  | ErrorBlock;

// =============================================================================
// Event handler type
// =============================================================================

export type EventHandler = (event: ChatEvent, builder: BlockBuilder) => void;

// =============================================================================
// BlockBuilder — pure engine
// =============================================================================

let _idCounter = 0;

export class BlockBuilder {
  private _blocks: Block[] = [];
  private _handlers = new Map<string, EventHandler | null>();
  private _onChange: (() => void) | null = null;

  // Active block refs — public so handlers can read/write them
  activeTextId: string | null = null;
  activeThinkingId: string | null = null;
  thinkingStartMs: number | null = null;
  activeEditorId: string | null = null;
  activeTodoId: string | null = null;

  // ── Registration ──────────────────────────────────────────────

  on(eventType: string, handler: EventHandler | null): void {
    this._handlers.set(eventType, handler);
  }

  registerHandlers(handlers: Record<string, EventHandler | null>): void {
    for (const [type, handler] of Object.entries(handlers)) {
      this._handlers.set(type, handler);
    }
  }

  // ── Event processing ──────────────────────────────────────────

  processEvent(event: ChatEvent): void {
    const handler = this._handlers.get(event.type);
    if (handler === null) return;
    if (!handler) return;
    handler(event, this);
  }

  // ── State ─────────────────────────────────────────────────────

  getBlocks(): Block[] {
    return [...this._blocks];
  }

  reset(): void {
    this._blocks = [];
    this.activeTextId = null;
    this.activeThinkingId = null;
    this.thinkingStartMs = null;
    this.activeEditorId = null;
    this.activeTodoId = null;
  }

  setOnChange(fn: (() => void) | null): void {
    this._onChange = fn;
  }

  // ── Block manipulation (used by handlers) ─────────────────────

  addBlock(block: Block): void {
    this._blocks = [...this._blocks, block];
    this._notify();
  }

  updateBlock<T extends Block["type"]>(
    id: string,
    updater: (
      block: Extract<Block, { type: T }>,
    ) => Extract<Block, { type: T }>,
  ): void {
    let changed = false;
    this._blocks = this._blocks.map((b) => {
      if (b.id !== id) return b;
      changed = true;
      return updater(b as Extract<Block, { type: T }>);
    });
    if (changed) this._notify();
  }

  /** Update any block by id with a partial update (type-loose for handlers). */
  patchBlock(id: string, patch: Partial<Block>): void {
    let changed = false;
    this._blocks = this._blocks.map((b) => {
      if (b.id !== id) return b;
      changed = true;
      return { ...b, ...patch } as Block;
    });
    if (changed) this._notify();
  }

  findBlock(predicate: (b: Block) => boolean): Block | undefined {
    for (let i = this._blocks.length - 1; i >= 0; i--) {
      const block = this._blocks[i];
      if (block && predicate(block)) return block;
    }
    return undefined;
  }

  nextId(): string {
    return `blk_${++_idCounter}`;
  }

  // ── Internal ──────────────────────────────────────────────────

  private _notify(): void {
    this._onChange?.();
  }
}
