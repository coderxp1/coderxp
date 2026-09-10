import { Key, ShieldCheck, Lock, Server, Zap, RefreshCw } from "lucide-react";

export default function ByokPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-12 md:py-16 space-y-12">
      <div className="text-center space-y-4 max-w-3xl mx-auto">
        <span className="text-xs font-mono text-accent-cyan uppercase tracking-widest px-2.5 py-1 rounded bg-accent-cyan/10 border border-accent-cyan/20">
          Primary Philosophy
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          Bring Your Own Keys (BYOK)
        </h1>
        <p className="text-sm sm:text-base text-gray-400">
          CoderXP is being designed to let developers connect supported provider credentials directly. BYOK routing and provider streaming are planned for a future milestone.
        </p>
      </div>

      <div className="glass-panel p-8 rounded-2xl space-y-8">
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Lock className="w-5 h-5 text-accent-cyan" /> AES-256-GCM Server Encryption Model (Planned)
          </h2>
          <p className="text-xs sm:text-sm text-gray-300 leading-relaxed">
            Secrets in the BYOK vault will be encrypted at rest using server-side AES-256-GCM before database storage. Raw API keys will never be exposed in browser storage, client bundles, or telemetry logs. This is a planned architecture specification, not yet implemented.
          </p>
        </div>

        <div className="border-t border-titanium-border/60 pt-6 space-y-3">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <RefreshCw className="w-5 h-5 text-accent-emerald" /> Rotation & Scope Governance
          </h2>
          <p className="text-xs sm:text-sm text-gray-300 leading-relaxed">
            Users will be able to instantly rotate, test connection latency, or revoke provider keys. Project-level scoping will ensure teams can isolate keys per project. (Planned)
          </p>
        </div>

        <div className="border-t border-titanium-border/60 pt-6 space-y-3">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Zap className="w-5 h-5 text-accent-amber" /> Direct Provider Streaming
          </h2>
          <p className="text-xs sm:text-sm text-gray-300 leading-relaxed">
            Requests are designed to stream directly from official provider endpoints (OpenAI, Anthropic, Google, DeepSeek) without intermediate proxy overhead. This is a planned capability, not yet implemented.
          </p>
        </div>
      </div>
    </div>
  );
}
