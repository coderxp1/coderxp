import Link from "next/link";
import { ArrowRight, Code2, Shield, Terminal, Cpu } from "lucide-react";

export default function AboutPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-12 md:py-16 space-y-12">
      
      {/* Title */}
      <div className="space-y-4 text-center">
        <span className="text-xs font-mono text-accent-cyan uppercase tracking-widest px-2.5 py-1 rounded bg-accent-cyan/10 border border-accent-cyan/20">
          Our Philosophy & Craftsmanship
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          Why We Built CoderXP
        </h1>
        <p className="text-base text-gray-400 max-w-2xl mx-auto">
          We refused to accept that AI coding platforms had to look like generic chat bots with fake typing animations and locked token subscriptions.
        </p>
      </div>

      {/* Content Grid */}
      <div className="space-y-8 glass-panel p-8 rounded-2xl">
        <div className="space-y-3">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Terminal className="w-5 h-5 text-accent-cyan" /> Authentic Software Engineering
          </h2>
          <p className="text-sm text-gray-300 leading-relaxed">
            Software engineering is about execution, verification, and precision. CoderXP is being engineered from the ground up to prioritize real terminal execution streams, genuine package resolution, and AST code diffing. These capabilities are planned for future milestones.
          </p>
        </div>

        <div className="border-t border-titanium-border/60 pt-6 space-y-3">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Shield className="w-5 h-5 text-accent-emerald" /> Bring Your Own Keys & Local LLMs
          </h2>
          <p className="text-sm text-gray-300 leading-relaxed">
            We believe developers should own their AI credentials. CoderXP will support direct API connections to OpenAI, Anthropic, Google Gemini, DeepSeek, and local LLMs (Ollama, LM Studio) without hidden markups. (Planned)
          </p>
        </div>

        <div className="border-t border-titanium-border/60 pt-6 space-y-3">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2">
            <Cpu className="w-5 h-5 text-accent-amber" /> Anti-Cliché Visual Identity
          </h2>
          <p className="text-sm text-gray-300 leading-relaxed">
            No purple or magenta glow effects, no emoji icons, and no fake loading screens. CoderXP adopts a dark obsidian titanium theme designed to feel like a high-performance operating system.
          </p>
        </div>
      </div>

      {/* CTA */}
      <div className="text-center pt-4">
        <Link
          href="/workspace"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-accent-cyan text-obsidian-deep font-semibold text-sm hover:bg-accent-cyan/90 transition-all"
        >
          Preview CoderXP Workspace <ArrowRight className="w-4 h-4" />
        </Link>
      </div>

    </div>
  );
}
