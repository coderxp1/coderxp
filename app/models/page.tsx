import { Cpu, ShieldCheck, Zap, Server } from "lucide-react";

export default function ModelsPage() {
  const providers = [
    { name: "Anthropic", models: ["Claude 3.5 Sonnet", "Claude 3.5 Haiku", "Claude 3 Opus"], type: "BYOK Provider", status: "Planned" },
    { name: "OpenAI", models: ["GPT-4o", "o1", "o3-mini", "GPT-4 Turbo"], type: "BYOK Provider", status: "Planned" },
    { name: "Google Gemini", models: ["Gemini 2.0 Flash", "Gemini 1.5 Pro"], type: "BYOK Provider", status: "Planned" },
    { name: "DeepSeek", models: ["DeepSeek-V3", "DeepSeek-R1 (Reasoner)"], type: "BYOK Provider", status: "Planned" },
    { name: "Mistral AI", models: ["Codestral", "Mistral Large 2"], type: "BYOK Provider", status: "Planned" },
    { name: "Groq", models: ["Llama-3.3-70b (Ultra Fast)"], type: "BYOK Provider", status: "Planned" },
    { name: "OpenRouter", models: ["Unified Multi-Model Gateway"], type: "BYOK Provider", status: "Planned" },
    { name: "Local Ollama", models: ["Llama 3.2, Qwen 2.5, DeepSeek-R1 Local"], type: "Local Bridge", status: "Architecture Proposal" },
    { name: "Local LM Studio", models: ["Custom Local GGUF Deployments"], type: "Local Bridge", status: "Architecture Proposal" },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 py-12 md:py-16 space-y-12">
      <div className="text-center space-y-4 max-w-3xl mx-auto">
        <span className="text-xs font-mono text-accent-cyan uppercase tracking-widest px-2.5 py-1 rounded bg-accent-cyan/10 border border-accent-cyan/20">
          AI Model Support & BYOK
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          Frontier & Local LLMs
        </h1>
        <p className="text-sm sm:text-base text-gray-400">
          Connect your choice of frontier commercial models or local LLM deployments. All provider integrations are planned for the roadmap.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {providers.map((p) => (
          <div key={p.name} className="p-6 rounded-xl glass-panel space-y-4 flex flex-col justify-between">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-accent-cyan">{p.type}</span>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-titanium-border/60 text-gray-300">
                  {p.status}
                </span>
              </div>
              <h3 className="text-lg font-semibold text-white">{p.name}</h3>
              <ul className="space-y-1 text-xs text-gray-400 font-mono">
                {p.models.map((m) => (
                  <li key={m} className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan/60" /> {m}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
