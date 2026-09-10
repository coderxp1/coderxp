import { Shield, Lock, Server, Key, AlertCircle } from "lucide-react";

export default function SecurityPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-12 md:py-16 space-y-12">
      <div className="text-center space-y-4 max-w-3xl mx-auto">
        <span className="text-xs font-mono text-accent-cyan uppercase tracking-widest px-2.5 py-1 rounded bg-accent-cyan/10 border border-accent-cyan/20">
          Trust & Architecture
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          Security Architecture
        </h1>
        <p className="text-sm sm:text-base text-gray-400">
          Technical explanation of CoderXP data isolation, BYOK key encryption, and execution boundaries.
        </p>
      </div>

      <div className="p-4 rounded-xl bg-obsidian-card border border-titanium-border text-xs text-gray-400 space-y-1">
        <div className="text-accent-amber font-mono font-semibold flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4" /> Legal Review Notice
        </div>
        <p>
          Draft security documentation. Formal third-party compliance certifications (SOC 2, ISO 27001) will be documented here once verified.
        </p>
      </div>

      <div className="space-y-6 glass-panel p-8 rounded-2xl">
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Lock className="w-5 h-5 text-accent-cyan" /> AES-256-GCM Encryption at Rest (Planned)
          </h2>
          <p className="text-xs sm:text-sm text-gray-300 leading-relaxed">
            All user-submitted API credentials stored in the BYOK vault will be encrypted server-side using AES-256-GCM before database write. Secret values will never be exposed in browser telemetry or public logs. This is a planned architecture specification, not yet implemented.
          </p>
        </div>

        <div className="border-t border-titanium-border/60 pt-6 space-y-3">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Server className="w-5 h-5 text-accent-emerald" /> Execution Container Isolation (Planned)
          </h2>
          <p className="text-xs sm:text-sm text-gray-300 leading-relaxed">
            Client previews will run inside sandboxed browser WebContainers. Backend operations will execute inside ephemeral, isolated server sandboxes destroyed upon completion. This is a planned architecture specification.
          </p>
        </div>
      </div>
    </div>
  );
}
