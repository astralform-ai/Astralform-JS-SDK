import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
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
} from "@astralform/js";
import { ChatSession as ChatSessionClass } from "@astralform/js";

export interface ChatState {
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
  send: (content: string, options?: SendOptions) => Promise<void>;
  createNewConversation: () => Promise<string>;
  switchConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  toggleTool: (name: string) => boolean;
  toggleMcp: (name: string) => boolean;
  disconnect: () => void;
}

const ChatContext = createContext<ChatState | null>(null);

export interface ChatProviderProps {
  config: AstralformConfig;
  storage?: ChatStorage;
  autoConnect?: boolean;
  children: ReactNode;
}

export function ChatProvider({
  config,
  storage,
  autoConnect = true,
  children,
}: ChatProviderProps) {
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

  const state: ChatState = {
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

  return <ChatContext.Provider value={state}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatState {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return context;
}
