import Link from "next/link";
import { HeroVideo } from "@/components/landing/HeroVideo";
import { 
  Terminal, 
  Key, 
  Cpu, 
  ShieldCheck, 
  Zap, 
  Code2, 
  Layers, 
  ArrowRight, 
  CheckCircle2, 
  Lock, 
  Globe, 
  Server,
  Sparkles,
  X,
  Check
} from "lucide-react";

export default function HomePage() {
  return (
    <div className="flex flex-col gap-16 md:gap-24 py-8 md:py-12">
      
      {/* HERO SECTION */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 md:pt-8 text-center space-y-8">
        
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-obsidian-card border border-titanium-border text-xs text-gray-300 font-mono">
          <Sparkles className="w-3.5 h-3.5 text-accent-cyan" />
          <span>The Signature AI Software Engineering Workspace</span>
        </div>

        {/* Main Headline */}
        <h1 className="text-4xl sm:text-6xl lg:text-7xl font-bold tracking-tight text-white max-w-5xl mx-auto leading-[1.1]">
          Software creation engineered for <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-gray-200 to-accent-cyan">craftsmen</span>.
        </h1>

        {/* Subtitle */}
        <p className="text-base sm:text-lg text-gray-400 max-w-3xl mx-auto leading-relaxed">
          CoderXP is an AI software engineering workspace in development. Bring-your-own-keys, local model bridge, and real execution are core goals of the roadmap.
        </p>

        {/* Call to Action Buttons */}
        <div className="flex flex-wrap items-center justify-center gap-4 pt-2">
          <Link
            href="/workspace"
            className="px-6 py-3.5 rounded-xl bg-accent-cyan text-obsidian-deep font-semibold text-sm hover:bg-accent-cyan/90 transition-all flex items-center gap-2 shadow-lg shadow-accent-cyan/20"
          >
            Preview Workspace
            <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/bring-your-own-key"
            className="px-6 py-3.5 rounded-xl bg-obsidian-card border border-titanium-border text-gray-200 font-semibold text-sm hover:bg-obsidian-hover hover:border-titanium-bright transition-all flex items-center gap-2"
          >
            <Key className="w-4 h-4 text-accent-cyan" />
            Explore BYOK Model
          </Link>
        </div>

        {/* CINEMATIC PRODUCT CONCEPT HERO CONTAINER */}
        <div className="pt-8 max-w-5xl mx-auto">
          <HeroVideo />
        </div>

      </section>

      {/* MODEL SUPPORT TICKER */}
      <section className="border-y border-titanium-border/80 bg-obsidian-card/60 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center space-y-4">
          <p className="text-xs uppercase tracking-widest font-mono text-gray-400">
            Planned Frontier & Local AI Model Support
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3 pt-2">
            {[
              { name: "Claude 3.5 Sonnet", type: "Anthropic" },
              { name: "GPT-4o / o3-mini", type: "OpenAI" },
              { name: "Gemini 2.0 Flash", type: "Google" },
              { name: "DeepSeek V3 / R1", type: "DeepSeek" },
              { name: "Codestral", type: "Mistral" },
              { name: "Ollama / LM Studio", type: "Local LLMs" }
            ].map((m) => (
              <div key={m.name} className="p-3 rounded-lg bg-obsidian-deep border border-titanium-border text-left">
                <p className="text-xs font-medium text-white">{m.name}</p>
                <p className="text-[11px] text-gray-400 font-mono mt-0.5">{m.type}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CORE FEATURES GRID */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
        <div className="text-center space-y-3">
          <h2 className="text-2xl sm:text-4xl font-bold text-white tracking-tight">
            Built for serious software engineering
          </h2>
          <p className="text-sm text-gray-400 max-w-2xl mx-auto">
            Every component in CoderXP is designed to feel like a high-performance developer OS.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          
          {/* Card 1 */}
          <div className="p-6 rounded-xl glass-panel space-y-4">
            <div className="w-10 h-10 rounded-lg bg-obsidian-deep border border-titanium-border flex items-center justify-center text-accent-cyan">
              <Terminal className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-semibold text-white">Real Terminal Execution <span className="text-[11px] text-gray-400 font-normal">(Planned)</span></h3>
            <p className="text-xs text-gray-400 leading-relaxed">
              No simulated installation bars or fake command logs. Authentic execution output directly from isolated execution containers is a core goal of the roadmap.
            </p>
            <div className="pt-2 text-[11px] font-mono text-gray-400 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-gray-400" /> Planned: authentic stdout / stderr streams
            </div>
          </div>

          {/* Card 2 */}
          <div className="p-6 rounded-xl glass-panel space-y-4">
            <div className="w-10 h-10 rounded-lg bg-obsidian-deep border border-titanium-border flex items-center justify-center text-accent-cyan">
              <Key className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-semibold text-white">Bring Your Own Keys (BYOK) <span className="text-[11px] text-gray-400 font-normal">(Planned)</span></h3>
            <p className="text-xs text-gray-400 leading-relaxed">
              CoderXP is being designed to let developers connect supported provider credentials directly. BYOK routing and provider streaming are planned for a future milestone.
            </p>
            <div className="pt-2 text-[11px] font-mono text-accent-cyan flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5" /> Planned: AES-256 encrypted key vault
            </div>
          </div>

          {/* Card 3 */}
          <div className="p-6 rounded-xl glass-panel space-y-4">
            <div className="w-10 h-10 rounded-lg bg-obsidian-deep border border-titanium-border flex items-center justify-center text-accent-cyan">
              <Cpu className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-semibold text-white">Local Model Bridge <span className="text-[11px] text-gray-400 font-normal">(Planned)</span></h3>
            <p className="text-xs text-gray-400 leading-relaxed">
              CoderXP is exploring secure connections to local Ollama and LM Studio environments. The local bridge is an architecture proposal and is not yet available.
            </p>
            <div className="pt-2 text-[11px] font-mono text-gray-400 flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5 text-accent-amber" /> Planned: local IPC bridge architecture
            </div>
          </div>

        </div>
      </section>

      {/* WHY CODERXP COMPARISON */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="p-8 sm:p-12 rounded-2xl glass-panel-elevated space-y-8">
          <div className="text-center space-y-3">
            <h2 className="text-2xl sm:text-3xl font-bold text-white">Why CoderXP is different</h2>
            <p className="text-sm text-gray-400">Comparing traditional AI builders with CoderXP engineering standards.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4">
            
            {/* Generic AI Coders */}
            <div className="p-6 rounded-xl bg-obsidian-deep/80 border border-red-900/30 space-y-3">
              <h3 className="text-sm font-semibold text-red-400 flex items-center gap-2">
                Generic AI Builders
              </h3>
              <ul className="space-y-2 text-xs text-gray-400 font-mono">
                <li className="flex items-center gap-2"><X className="w-3.5 h-3.5 text-red-400" /> Simulated fake typing animations</li>
                <li className="flex items-center gap-2"><X className="w-3.5 h-3.5 text-red-400" /> Forced monthly API token markups</li>
                <li className="flex items-center gap-2"><X className="w-3.5 h-3.5 text-red-400" /> Clickbait purple/magenta glow themes</li>
                <li className="flex items-center gap-2"><X className="w-3.5 h-3.5 text-red-400" /> Single-provider vendor lock-in</li>
              </ul>
            </div>

            {/* CoderXP Standards */}
            <div className="p-6 rounded-xl bg-obsidian-deep/80 border border-emerald-800/40 space-y-3">
              <h3 className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
                CoderXP Craftsmanship
              </h3>
              <ul className="space-y-2 text-xs text-gray-200 font-mono">
                <li className="flex items-center gap-2"><ArrowRight className="w-3.5 h-3.5 text-emerald-400" /> Real terminal stdout/stderr stream execution (Planned)</li>
                <li className="flex items-center gap-2"><ArrowRight className="w-3.5 h-3.5 text-emerald-400" /> BYOK First: OpenAI, Anthropic, Gemini, DeepSeek, Local (Planned)</li>
                <li className="flex items-center gap-2"><Check className="w-3.5 h-3.5 text-emerald-400" /> Obsidian titanium developer-first aesthetic</li>
                <li className="flex items-center gap-2"><ArrowRight className="w-3.5 h-3.5 text-emerald-400" /> Open standards &amp; project ZIP export (M2)</li>
              </ul>
            </div>

          </div>
        </div>
      </section>

      {/* BUILT FOR USER ROLES (AUTHENTIC TESTIMONIAL CAROUSEL) */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-bold text-white">Engineered for your workflow</h2>
          <p className="text-xs text-gray-400">Early-access personas and target engineering profiles.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            {
              role: "Indie Founders & Solo Devs",
              desc: "Ship full-stack SaaS products using BYOK keys without paying high monthly token subscription overheads. BYOK is a planned feature.",
              highlight: "BYOK & Speed (Planned)"
            },
            {
              role: "Senior Software Engineers",
              desc: "Inspect real AST diffs, terminal outputs, and dependency trees rather than guessing what AI generated. These capabilities are planned for the roadmap.",
              highlight: "Real Execution (Planned)"
            },
            {
              role: "Privacy-Conscious Teams",
              desc: "Run local Ollama or LM Studio models via a planned local bridge for private internal code generation. This is an architecture proposal, not yet available.",
              highlight: "Local LLM Bridge (Planned)"
            }
          ].map((item) => (
            <div key={item.role} className="p-6 rounded-xl glass-panel space-y-3">
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20">
                {item.highlight}
              </span>
              <h3 className="text-sm font-semibold text-white">{item.role}</h3>
              <p className="text-xs text-gray-400 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FINAL CALL TO ACTION */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center space-y-6">
        <div className="p-10 rounded-2xl glass-panel-elevated space-y-6 border border-titanium-bright/40">
          <h2 className="text-3xl font-bold text-white tracking-tight">
            Ready to experience authentic AI software engineering?
          </h2>
          <p className="text-sm text-gray-400 max-w-xl mx-auto">
            Preview the workspace, explore the BYOK and local model architecture, and follow the roadmap toward real execution.
          </p>
          <div className="flex justify-center gap-4">
            <Link
              href="/workspace"
              className="px-6 py-3.5 rounded-xl bg-accent-cyan text-obsidian-deep font-semibold text-sm hover:bg-accent-cyan/90 transition-all flex items-center gap-2"
            >
              Preview Workspace Now
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

    </div>
  );
}
