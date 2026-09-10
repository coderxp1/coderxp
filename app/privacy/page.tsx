import { Shield, AlertCircle } from "lucide-react";

export default function PrivacyPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-12 md:py-16 space-y-8 text-xs text-gray-300">
      
      <div className="space-y-4">
        <span className="text-xs font-mono text-accent-cyan uppercase tracking-widest px-2.5 py-1 rounded bg-accent-cyan/10 border border-accent-cyan/20">
          Governance
        </span>
        <h1 className="text-3xl font-bold text-white tracking-tight">Privacy Policy</h1>
        <p className="text-gray-400">Last updated: July 2026</p>
      </div>

      <div className="p-4 rounded-xl bg-obsidian-card border border-titanium-border text-xs text-gray-400 space-y-1">
        <div className="text-accent-amber font-mono font-semibold flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4" /> Legal Review Draft Notice
        </div>
        <p>
          This privacy policy is a draft statement for CoderXP Milestone 1. Formal legal compliance statements (e.g. GDPR, CCPA certifications) will be finalized after legal review.
        </p>
      </div>

      <div className="glass-panel p-8 rounded-2xl space-y-6 leading-relaxed">
        <h2 className="text-sm font-semibold text-white uppercase tracking-wider font-mono">1. Information Collection</h2>
        <p>
          CoderXP collects minimal account information (email, OAuth authentication metadata) necessary to operate the application.
        </p>

        <h2 className="text-sm font-semibold text-white uppercase tracking-wider font-mono">2. API Credentials & BYOK Data</h2>
        <p>
          User-supplied API keys (OpenAI, Anthropic, Gemini, DeepSeek) will be stored using server-side AES-256-GCM encryption and used solely to proxy LLM requests on the user&apos;s behalf. (Planned architecture)
        </p>

        <h2 className="text-sm font-semibold text-white uppercase tracking-wider font-mono">3. Local Models Data</h2>
        <p>
          Requests sent to local model endpoints (Ollama, LM Studio) remain entirely within your local network environment.
        </p>
      </div>

    </div>
  );
}
