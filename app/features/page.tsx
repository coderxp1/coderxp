import Link from "next/link";
import { Terminal, Key, Cpu, Code2, Layers, CheckCircle2, Shield, Eye, FileCode } from "lucide-react";

export default function FeaturesPage() {
  const featuresList = [
    {
      title: "Real Terminal Execution Engine",
      desc: "Watch real stdout and stderr streams during build and package installation steps. Zero simulated typing or invented command logs.",
      icon: Terminal,
      capabilityStatus: "Roadmap Item (Planned)",
    },
    {
      title: "Encrypted BYOK Vault",
      desc: "Store and rotate API keys for OpenAI, Anthropic, Gemini, DeepSeek, Groq, and OpenRouter with server-side AES-256 encryption.",
      icon: Key,
      capabilityStatus: "Roadmap Item (Planned)",
    },
    {
      title: "Local Model Security Bridge",
      desc: "CoderXP is exploring secure connections to local Ollama and LM Studio environments. The local bridge is an architecture proposal and is not yet available.",
      icon: Cpu,
      capabilityStatus: "Technical Proposal (Planned)",
    },
    {
      title: "3-Panel Signature Workspace",
      desc: "Adaptable three-panel layout featuring context history on the left, syntax-highlighted editor in center, and live preview runner on the right.",
      icon: Layers,
      capabilityStatus: "Milestone 2 (In Progress)",
    },
    {
      title: "AST Code Diffing & Review",
      desc: "Inspect granular syntax changes before committing code modifications to your project files.",
      icon: FileCode,
      capabilityStatus: "Roadmap Item (Planned)",
    },
    {
      title: "Interactive Sandbox Live Preview",
      desc: "Every project renders inside an isolated live preview runner supporting desktop, tablet, and mobile viewports.",
      icon: Eye,
      capabilityStatus: "Milestone 2 (In Progress)",
    },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 py-12 md:py-16 space-y-12">
      <div className="text-center space-y-4 max-w-3xl mx-auto">
        <span className="text-xs font-mono text-accent-cyan uppercase tracking-widest px-2.5 py-1 rounded bg-accent-cyan/10 border border-accent-cyan/20">
          Product Capabilities & Roadmap
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          Engineered for Technical Precision
        </h1>
        <p className="text-sm sm:text-base text-gray-400">
          Explore the architecture driving CoderXP. Features labeled accurately based on internal capability verification.
        </p>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {featuresList.map((f) => {
          const Icon = f.icon;
          return (
            <div key={f.title} className="p-6 rounded-xl glass-panel space-y-4 flex flex-col justify-between">
              <div className="space-y-3">
                <div className="w-10 h-10 rounded-lg bg-obsidian-deep border border-titanium-border flex items-center justify-center text-accent-cyan">
                  <Icon className="w-5 h-5" />
                </div>
                <h3 className="text-base font-semibold text-white">{f.title}</h3>
                <p className="text-xs text-gray-400 leading-relaxed">{f.desc}</p>
              </div>
              <div className="pt-3 border-t border-titanium-border/60">
                <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-titanium-border/60 text-gray-400">
                  {f.capabilityStatus}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
