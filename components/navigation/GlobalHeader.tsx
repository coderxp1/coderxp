"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { 
  Key, 
  Cpu, 
  Sparkles, 
  Terminal, 
  ShieldCheck, 
  Menu, 
  X, 
  ArrowRight,
  Code2
} from "lucide-react";

export function GlobalHeader() {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  if (pathname === "/workspace" || pathname?.startsWith("/workspace/")) {
    return null;
  }

  const mainNav = [
    { name: "Features", href: "/features", icon: Sparkles },
    { name: "Workspace", href: "/workspace", icon: Terminal },
    { name: "AI Models", href: "/models", icon: Cpu },
    { name: "BYOK", href: "/bring-your-own-key", icon: Key },
    { name: "Local LLMs", href: "/local-models", icon: Code2 },
    { name: "Pricing", href: "/pricing", icon: ShieldCheck },
  ];

  return (
    <header className="sticky top-0 z-50 w-full border-b border-titanium-border/70 glass-panel">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        
        {/* Logo */}
        <Link href="/" className="flex items-center gap-3 group">
          <div className="relative w-8 h-8 flex items-center justify-center rounded-lg bg-obsidian-card border border-titanium-border group-hover:border-accent-cyan/50 transition-colors">
            <Image
              src="/logo-optimized.png"
              alt="CoderXP"
              width={24}
              height={24}
              className="object-contain"
              priority
            />
          </div>
          <span className="font-semibold tracking-tight text-white text-lg flex items-center gap-2">
            Coder<span className="text-accent-cyan">XP</span>
            <span className="text-[11px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-titanium-border/60 text-gray-400 font-mono">
              M1
            </span>
          </span>
        </Link>

        {/* Desktop Navigation */}
        <nav className="hidden md:flex items-center gap-1">
          {mainNav.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5 ${
                  isActive
                    ? "bg-obsidian-elevated text-white border border-titanium-border"
                    : "text-gray-300 hover:text-white hover:bg-obsidian-hover"
                }`}
              >
                <Icon className="w-3.5 h-3.5 text-accent-cyan/80" />
                {item.name}
              </Link>
            );
          })}
        </nav>

        {/* Actions */}
        <div className="hidden md:flex items-center gap-3">
          <Link
            href="/docs"
            className="text-xs text-gray-400 hover:text-gray-200 transition-colors font-mono"
          >
            Docs
          </Link>
          <Link
            href="/workspace"
            className="px-4 py-2 rounded-lg bg-accent-cyan text-obsidian-deep text-xs font-semibold hover:bg-accent-cyan/90 transition-all flex items-center gap-1.5 shadow-sm shadow-accent-cyan/20"
          >
            Preview Workspace
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {/* Mobile menu button */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="md:hidden p-2 rounded-md text-gray-400 hover:text-white hover:bg-obsidian-hover"
          aria-label="Toggle Navigation"
        >
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="md:hidden border-b border-titanium-border bg-obsidian-card p-4 space-y-2">
          {mainNav.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-gray-300 hover:text-white hover:bg-obsidian-hover"
              >
                <Icon className="w-4 h-4 text-accent-cyan" />
                {item.name}
              </Link>
            );
          })}
          <div className="pt-3 border-t border-titanium-border flex flex-col gap-2">
            <Link
              href="/workspace"
              onClick={() => setMobileMenuOpen(false)}
              className="w-full text-center py-2.5 rounded-lg bg-accent-cyan text-obsidian-deep text-xs font-semibold"
            >
              Preview Workspace
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
