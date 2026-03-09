import { useEffect, useRef, useState, useCallback } from "react";
import type {
  AstralformConfig,
  ChatStorage,
  ChatSession,
  ChatEvent,
  Message,
  Conversation,
  ProjectStatus,
  AgentInfo,
  PlatformTool,
  ServerMCPTool,
  SendOptions,
  SubagentState,
  ToolState,
  CapsuleOutput,
  Source,
  TodoItem,
} from "@astralform/js";
import { ChatSession as ChatSessionClass } from "@astralform/js";

export interface UseChatOptions {
  storage?: ChatStorage;
  autoConnect?: boolean;
}

export interface UseChatReturn {
  session: ChatSession;
  messages: Message[];
  conversations: Conversation[];
  conversationId: string | null;
  isStreaming: boolean;
  streamingContent: string;
  executingTool: string | null;
  projectStatus: ProjectStatus | null;
  agents: AgentInfo[];
  platformTools: PlatformTool[];
  mcpTools: ServerMCPTool[];
  enabledTools: Set<string>;
  enabledMcp: Set<string>;
  modelDisplayName: string | null;
  error: Error | null;
  isConnected: boolean;
  activeAgent: string | null;
  thinkingContent: string;
  isThinking: boolean;
  activeSubagents: Map<string, SubagentState>;
  sources: Source[];
  capsuleOutputs: CapsuleOutput[];
  todos: TodoItem[];
  activeTools: Map<string, ToolState>;
  send: (content: string, options?: SendOptions) => Promise<void>;
  createNewConversation: () => Promise<string>;
  switchConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  toggleTool: (name: string) => boolean;
  toggleMcp: (name: string) => boolean;
  disconnect: () => void;
}

export function useChat(
  config: AstralformConfig,
  options?: UseChatOptions,
): UseChatReturn {
  const { storage, autoConnect = true } = options ?? {};
  const sessionRef = useRef<ChatSession | null>(null);
  const [, forceUpdate] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);

  if (!sessionRef.current) {
    sessionRef.current = new ChatSessionClass(config, storage);
  }

  const session = sessionRef.current;

  const sync = useCallback(() => {
    forceUpdate((n) => n + 1);
  }, []);

  useEffect(() => {
    const unsubscribe = session.on((event: ChatEvent) => {
      switch (event.type) {
        case "connected":
          setIsConnected(true);
          sync();
          break;
        case "chunk":
        case "tool_call":
        case "tool_executing":
        case "tool_completed":
        case "tool_end":
        case "thinking_delta":
        case "thinking_complete":
        case "subagent_start":
        case "subagent_update":
        case "subagent_chunk":
        case "subagent_end":
        case "sources":
        case "capsule_output":
        case "todo_update":
          sync();
          break;
        case "agent_start":
          setActiveAgent(event.agentDisplayName ?? event.agentName);
          sync();
          break;
        case "agent_end":
          setActiveAgent(null);
          sync();
          break;
        case "complete":
          sync();
          break;
        case "error":
          setError(event.error);
          sync();
          break;
        case "disconnected":
          setIsConnected(false);
          sync();
          break;
      }
    });

    if (autoConnect) {
      session.connect().catch((err: unknown) => {
        setError(err instanceof Error ? err : new Error(String(err)));
      });
    }

    return () => {
      unsubscribe();
      session.disconnect();
    };
  }, [session, autoConnect, sync]);

  const send = useCallback(
    async (content: string, options?: SendOptions) => {
      setError(null);
      await session.send(content, options);
    },
    [session],
  );

  const createNewConversation = useCallback(async () => {
    const id = await session.createNewConversation();
    sync();
    return id;
  }, [session, sync]);

  const switchConversation = useCallback(
    async (id: string) => {
      await session.switchConversation(id);
      sync();
    },
    [session, sync],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      await session.deleteConversation(id);
      sync();
    },
    [session, sync],
  );

  const toggleTool = useCallback(
    (name: string) => {
      const result = session.toggleTool(name);
      sync();
      return result;
    },
    [session, sync],
  );

  const toggleMcp = useCallback(
    (name: string) => {
      const result = session.toggleMcp(name);
      sync();
      return result;
    },
    [session, sync],
  );

  const disconnect = useCallback(() => {
    session.disconnect();
  }, [session]);

  return {
    session,
    messages: session.messages,
    conversations: session.conversations,
    conversationId: session.conversationId,
    isStreaming: session.isStreaming,
    streamingContent: session.streamingContent,
    executingTool: session.executingTool,
    projectStatus: session.projectStatus,
    agents: session.agents,
    platformTools: session.platformTools,
    mcpTools: session.mcpTools,
    enabledTools: session.enabledTools,
    enabledMcp: session.enabledMcp,
    modelDisplayName: session.modelDisplayName,
    thinkingContent: session.thinkingContent,
    isThinking: session.isThinking,
    activeSubagents: session.activeSubagents,
    sources: session.sources,
    capsuleOutputs: session.capsuleOutputs,
    todos: session.todos,
    activeTools: session.activeTools,
    error,
    isConnected,
    activeAgent,
    send,
    createNewConversation,
    switchConversation,
    deleteConversation,
    toggleTool,
    toggleMcp,
    disconnect,
  };
}
