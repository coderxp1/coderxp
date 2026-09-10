import Link from "next/link";
import { Check, Key, Zap, Shield, ArrowRight } from "lucide-react";

export default function PricingPage() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-12 md:py-16 space-y-12">
      <div className="text-center space-y-4 max-w-3xl mx-auto">
        <span className="text-xs font-mono text-accent-cyan uppercase tracking-widest px-2.5 py-1 rounded bg-accent-cyan/10 border border-accent-cyan/20">
          Transparent Pricing Model
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          BYOK First & Managed AI
        </h1>
        <p className="text-sm sm:text-base text-gray-400">
          Use CoderXP for free with your own API keys or upgrade to Managed AI for hosted execution.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-4">
        
        {/* BYOK Free Forever Plan */}
        <div className="p-8 rounded-2xl glass-panel space-y-6 flex flex-col justify-between border border-titanium-border">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent-cyan/10 text-accent-cyan text-xs font-mono">
              <Key className="w-3.5 h-3.5" /> Primary Philosophy
            </div>
            <h2 className="text-2xl font-bold text-white">BYOK Free Tier</h2>
            <p className="text-xs text-gray-400">For developers & teams connecting direct provider API keys.</p>
            <div className="text-3xl font-bold text-white font-mono">$0 <span className="text-xs font-normal text-gray-400">/ forever</span></div>
            <ul className="space-y-2.5 text-xs text-gray-300">
              <li className="flex items-center gap-2"><Check className="w-4 h-4 text-gray-400" /> Unlimited BYOK keys (OpenAI, Anthropic, Gemini, DeepSeek) (Planned)</li>
              <li className="flex items-center gap-2"><Check className="w-4 h-4 text-gray-400" /> Local LLM Bridge (Ollama, LM Studio) (Planned)</li>
              <li className="flex items-center gap-2"><Check className="w-4 h-4 text-gray-400" /> 3-Panel Signature Workspace UI (Planned)</li>
              <li className="flex items-center gap-2"><Check className="w-4 h-4 text-gray-400" /> Browser WebContainer Execution Engine (Planned)</li>
            </ul>
          </div>
          <Link href="/workspace" className="w-full py-3 rounded-xl bg-obsidian-card border border-titanium-border hover:border-accent-cyan text-white font-semibold text-xs text-center transition-colors">
            Preview Workspace
          </Link>
        </div>

        {/* Managed AI Pro Plan */}
        <div className="p-8 rounded-2xl glass-panel-elevated space-y-6 flex flex-col justify-between border border-accent-cyan/40 shadow-xl shadow-accent-cyan/10">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-950 text-emerald-400 text-xs font-mono">
              <Zap className="w-3.5 h-3.5" /> Hosted Infrastructure
            </div>
            <h2 className="text-2xl font-bold text-white">Managed AI Pro</h2>
            <p className="text-xs text-gray-400">For engineers who prefer hosted AI routing without managing individual API keys.</p>
            <div className="text-3xl font-bold text-white font-mono">$29 <span className="text-xs font-normal text-gray-400">/ month</span></div>
            <ul className="space-y-2.5 text-xs text-gray-300">
              <li className="flex items-center gap-2"><Check className="w-4 h-4 text-gray-400" /> Hosted Mastra AI Orchestration (Planned)</li>
              <li className="flex items-center gap-2"><Check className="w-4 h-4 text-gray-400" /> High-speed isolated container sandbox execution (Planned)</li>
              <li className="flex items-center gap-2"><Check className="w-4 h-4 text-gray-400" /> Full BYOK fallback capability (Planned)</li>
              <li className="flex items-center gap-2"><Check className="w-4 h-4 text-gray-400" /> Priority server execution queue (Planned)</li>
            </ul>
          </div>
          <Link href="/workspace" className="w-full py-3 rounded-xl bg-accent-cyan text-obsidian-deep font-semibold text-xs text-center hover:bg-accent-cyan/90 transition-colors">
            Join Waitlist
          </Link>
        </div>

      </div>
    </div>
  );
}
