import { Code2, Key, Shield, Server } from "lucide-react";

export default function ApiPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-12 md:py-16 space-y-12">
      <div className="text-center space-y-4 max-w-3xl mx-auto">
        <span className="text-xs font-mono text-accent-cyan uppercase tracking-widest px-2.5 py-1 rounded bg-accent-cyan/10 border border-accent-cyan/20">
          Future Milestone Roadmap
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          CoderXP Public API Platform
        </h1>
        <p className="text-sm sm:text-base text-gray-400">
          Developer platform specifications for programmatic workspace generation, key management, and execution hooks.
        </p>
      </div>

      <div className="p-4 rounded-xl bg-obsidian-card border border-titanium-border text-xs text-gray-300 font-mono">
        <span className="text-accent-cyan font-semibold block mb-1">Status: Future Roadmap Item (Planned)</span>
        The public API platform is a future milestone. Endpoint specifications below illustrate the planned API schema once the core engine reaches verification.
      </div>

      <div className="glass-panel p-6 rounded-xl space-y-4 font-mono text-xs">
        <div className="flex items-center justify-between border-b border-titanium-border pb-2 text-gray-400">
          <span>POST /v1/workspaces/create</span>
          <span className="text-accent-cyan">Planned Schema</span>
        </div>
        <pre className="text-gray-300 p-4 rounded bg-obsidian-deep border border-titanium-border/60 overflow-x-auto">
{`{
  "project_name": "saas-dashboard",
  "template": "nextjs-14-tailwind",
  "provider": "anthropic",
  "model": "claude-3-5-sonnet",
  "byok_vault_ref": "key_vault_0192a"
}`}
        </pre>
      </div>
    </div>
  );
}
