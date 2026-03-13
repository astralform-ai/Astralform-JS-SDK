import { createRoot } from "react-dom/client";
import { useState, type FormEvent } from "react";
import { ChatProvider, ChatContainer } from "@astralform/react";

function SetupForm({
  onConnect,
}: {
  onConnect: (apiKey: string, baseURL: string) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("https://api.astralform.ai");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (apiKey.trim()) {
      onConnect(apiKey.trim(), baseURL.trim());
    }
  };

  return (
    <div className="flex h-full items-center justify-center">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6"
      >
        <h1 className="text-lg font-semibold text-zinc-100">
          Astralform Agent Demo
        </h1>
        <p className="text-sm text-zinc-500">
          Connect to your multi-agent project to see thinking, subagent
          delegation, tool execution, and more.
        </p>

        <div>
          <label className="block text-xs text-zinc-400 mb-1">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="ak_..."
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none"
            required
          />
        </div>

        <div>
          <label className="block text-xs text-zinc-400 mb-1">
            Endpoint URL
          </label>
          <input
            type="url"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
        >
          Connect
        </button>
      </form>
    </div>
  );
}

function App() {
  const [config, setConfig] = useState<{
    apiKey: string;
    baseURL: string;
  } | null>(null);

  if (!config) {
    return (
      <SetupForm
        onConnect={(apiKey, baseURL) => setConfig({ apiKey, baseURL })}
      />
    );
  }

  return (
    <ChatProvider
      config={{
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        userId: "demo-user",
      }}
    >
      <ChatContainer className="h-full" showSidebar />
    </ChatProvider>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
