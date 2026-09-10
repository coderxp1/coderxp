import { MessageSquare, Github, ArrowRight } from "lucide-react";

export default function ContactPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-12 md:py-16 space-y-12">
      <div className="text-center space-y-4 max-w-3xl mx-auto">
        <span className="text-xs font-mono text-accent-cyan uppercase tracking-widest px-2.5 py-1 rounded bg-accent-cyan/10 border border-accent-cyan/20">
          Developer & Enterprise Support
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          Get in Touch
        </h1>
        <p className="text-sm sm:text-base text-gray-400">
          Have technical questions about BYOK keys, local model bridge, or enterprise deployments?
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Support Card 1 */}
        <div className="p-6 rounded-xl glass-panel space-y-4">
          <div className="w-10 h-10 rounded-lg bg-obsidian-deep border border-titanium-border flex items-center justify-center text-accent-cyan">
            <Github className="w-5 h-5" />
          </div>
          <h3 className="text-base font-semibold text-white">GitHub Community & Issues</h3>
          <p className="text-xs text-gray-400 leading-relaxed">
            Report bugs, request feature capabilities, or contribute to CoderXP on GitHub.
          </p>
          <a
            href="https://github.com/phartmann80/coderxp"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-accent-cyan font-mono hover:underline pt-2"
          >
            Visit GitHub Repository <ArrowRight className="w-3.5 h-3.5" />
          </a>
        </div>

        {/* Support Card 2 */}
        <div className="p-6 rounded-xl glass-panel space-y-4">
          <div className="w-10 h-10 rounded-lg bg-obsidian-deep border border-titanium-border flex items-center justify-center text-accent-emerald">
            <MessageSquare className="w-5 h-5" />
          </div>
          <h3 className="text-base font-semibold text-white">Developer Support</h3>
          <p className="text-xs text-gray-400 leading-relaxed">
            Direct communication channel for technical team inquiries and BYOK integration guidance.
          </p>
          <span className="inline-flex items-center gap-1.5 text-xs text-accent-emerald font-mono pt-2">
            Support channel coming soon
          </span>
        </div>

      </div>
    </div>
  );
}
