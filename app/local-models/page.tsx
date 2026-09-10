import { Cpu, Server, AlertTriangle, Code2 } from "lucide-react";

export default function LocalModelsPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-12 md:py-16 space-y-12">
      <div className="text-center space-y-4 max-w-3xl mx-auto">
        <span className="text-xs font-mono text-accent-cyan uppercase tracking-widest px-2.5 py-1 rounded bg-accent-cyan/10 border border-accent-cyan/20">
          Architecture & Privacy
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          Local Model Bridge Specification
        </h1>
        <p className="text-sm sm:text-base text-gray-400">
          Technical proposal for connecting local LLM instances (Ollama, LM Studio) to hosted web interfaces safely.
        </p>
      </div>

      {/* Scope Clarification Alert */}
      <div className="p-4 rounded-xl bg-obsidian-card border border-titanium-border space-y-2 text-xs text-gray-300">
        <div className="flex items-center gap-2 text-accent-amber font-semibold font-mono">
          <AlertTriangle className="w-4 h-4" /> Hosted Server vs Local Environment Scope
        </div>
        <p className="text-gray-400 leading-relaxed">
          When CoderXP runs as a web app, <code className="text-gray-200">http://localhost:11434</code> refers to the user&apos;s computer, not the hosting web server. CoderXP is designing a secure bridge for this network boundary. The local-model connection remains an architecture proposal and is not yet available.
        </p>
      </div>

      {/* Proposals */}
      <div className="space-y-6">
        <div className="p-6 rounded-xl glass-panel space-y-3">
          <h3 className="text-base font-semibold text-white flex items-center gap-2">
            <Code2 className="w-5 h-5 text-accent-cyan" /> Option A: Browser-Direct CORS Connection
          </h3>
          <p className="text-xs text-gray-300 leading-relaxed">
            The browser would execute client-side <code className="text-accent-cyan font-mono">fetch()</code> directly to <code className="text-gray-200 font-mono">http://localhost:11434</code>. This would require setting <code className="text-gray-200 font-mono">OLLAMA_ORIGINS=&quot;https://coderxp.pro&quot;</code> to grant explicit CORS permission. This option is proposed but not yet implemented.
          </p>
        </div>

        <div className="p-6 rounded-xl glass-panel space-y-3">
          <h3 className="text-base font-semibold text-white flex items-center gap-2">
            <Server className="w-5 h-5 text-accent-emerald" /> Option B: Secure Local Bridge CLI Daemon
          </h3>
          <p className="text-xs text-gray-300 leading-relaxed">
            A lightweight open-source CLI utility (<code className="text-emerald-400 font-mono">coderxp-bridge</code>) would create a token-authenticated local WebSocket tunnel with user consent verification. This is an architecture proposal, not yet implemented.
          </p>
        </div>

        <div className="p-6 rounded-xl glass-panel space-y-3">
          <h3 className="text-base font-semibold text-white flex items-center gap-2">
            <Cpu className="w-5 h-5 text-accent-amber" /> Option C: Local-First Desktop Edition
          </h3>
          <p className="text-xs text-gray-300 leading-relaxed">
            Tauri / Electron packaging for native zero-CORS local IPC communication. This is a planned future option, not yet in development.
          </p>
        </div>
      </div>
    </div>
  );
}
