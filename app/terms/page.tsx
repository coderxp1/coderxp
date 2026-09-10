import { AlertCircle } from "lucide-react";

export default function TermsPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-12 md:py-16 space-y-8 text-xs text-gray-300">
      <div className="space-y-4">
        <span className="text-xs font-mono text-accent-cyan uppercase tracking-widest px-2.5 py-1 rounded bg-accent-cyan/10 border border-accent-cyan/20">
          Governance
        </span>
        <h1 className="text-3xl font-bold text-white tracking-tight">Terms of Service</h1>
        <p className="text-gray-400">Last updated: July 2026</p>
      </div>

      <div className="p-4 rounded-xl bg-obsidian-card border border-titanium-border text-xs text-gray-400 space-y-1">
        <div className="text-accent-amber font-mono font-semibold flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4" /> Legal Review Draft Notice
        </div>
        <p>
          Terms of service draft for CoderXP Milestone 1 release. Subject to formal legal counsel approval.
        </p>
      </div>

      <div className="glass-panel p-8 rounded-2xl space-y-6 leading-relaxed">
        <h2 className="text-sm font-semibold text-white uppercase tracking-wider font-mono">1. Acceptance of Terms</h2>
        <p>
          By accessing or using CoderXP, you agree to comply with these terms of service.
        </p>

        <h2 className="text-sm font-semibold text-white uppercase tracking-wider font-mono">2. BYOK Responsibility</h2>
        <p>
          Users connecting direct API keys are responsible for complying with the terms and rate limits of their third-party AI provider (OpenAI, Anthropic, Google, etc.).
        </p>
      </div>
    </div>
  );
}
