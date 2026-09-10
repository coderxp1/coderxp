import Link from "next/link";
import { Terminal, Key, Cpu, Code2, ShieldCheck, BookOpen, ArrowRight } from "lucide-react";

export default function DocsPage() {
  const docsCategories = [
    { title: "Getting Started", desc: "Setting up your CoderXP workspace and baseline configuration.", href: "/workspace" },
    { title: "Bring Your Own Key (BYOK)", desc: "Storing, encrypting, and rotating API keys securely.", href: "/bring-your-own-key" },
    { title: "Local Model Bridge", desc: "Connecting local Ollama and LM Studio instances.", href: "/local-models" },
    { title: "AI Model Matrix", desc: "Supported frontier and local models overview.", href: "/models" },
    { title: "Security Architecture", desc: "Encryption standards, container isolation, and data governance.", href: "/security" },
    { title: "API Specifications", desc: "Roadmap specifications for CoderXP API platform.", href: "/api" },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 py-12 md:py-16 space-y-12">
      <div className="text-center space-y-4 max-w-3xl mx-auto">
        <span className="text-xs font-mono text-accent-cyan uppercase tracking-widest px-2.5 py-1 rounded bg-accent-cyan/10 border border-accent-cyan/20">
          Knowledge Base
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          CoderXP Documentation
        </h1>
        <p className="text-sm sm:text-base text-gray-400">
          Guides, specifications, and technical reference for the CoderXP workspace platform.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {docsCategories.map((doc) => (
          <Link key={doc.title} href={doc.href} className="p-6 rounded-xl glass-panel hover:border-accent-cyan/40 transition-all space-y-3 group">
            <h3 className="text-base font-semibold text-white group-hover:text-accent-cyan transition-colors flex items-center justify-between">
              {doc.title}
              <ArrowRight className="w-4 h-4 text-gray-400 group-hover:text-accent-cyan transition-colors" />
            </h3>
            <p className="text-xs text-gray-400 leading-relaxed">{doc.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
