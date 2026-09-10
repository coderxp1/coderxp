"use client";

import { useSyncExternalStore } from "react";
import Image from "next/image";
import { Shield, Terminal, Cpu, ArrowRight } from "lucide-react";

interface HeroVideoProps {
  desktopSrc?: string;
  mobileSrc?: string;
  posterDesktop?: string;
  posterMobile?: string;
  videoEnabled?: boolean;
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (callback) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", callback);
      return () => mql.removeEventListener("change", callback);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}

function useIsClient(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

export function HeroVideo({
  desktopSrc = "/video/coderxp-hero-desktop.mp4",
  mobileSrc = "/video/coderxp-hero-mobile.mp4",
  posterDesktop = "/images/coderxp-hero-poster-desktop.webp",
  posterMobile = "/images/coderxp-hero-poster-mobile.webp",
  videoEnabled = false,
}: HeroVideoProps) {
  const mounted = useIsClient();
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const isDesktop = useMediaQuery("(min-width: 768px)");

  // When videoEnabled is false, we never render the <video> element or request MP4s.
  const showVideo = videoEnabled && mounted && !prefersReducedMotion;

  // Only render the appropriate poster to avoid duplicate downloads
  const posterSrc = isDesktop ? posterDesktop : posterMobile;
  const posterSizes = isDesktop
    ? "(max-width: 1200px) 100vw, 1200px"
    : "100vw";

  return (
    <div className="relative w-full aspect-video rounded-xl overflow-hidden border border-titanium-border bg-obsidian-card glass-panel titanium-border-glow shadow-2xl">

      {/* Optimized poster layer — the LCP element */}
      {/* Only the appropriate poster for the current viewport is rendered */}
      {mounted && (
        <Image
          src={posterSrc}
          alt="CoderXP workspace concept preview"
          fill
          priority
          sizes={posterSizes}
          className="object-cover"
          quality={75}
        />
      )}

      {/* Video element — only rendered when videoEnabled is true and motion is allowed */}
      {showVideo && (
        <video
          className="absolute inset-0 w-full h-full object-cover transition-opacity duration-700 opacity-0"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
        >
          <source src={desktopSrc} type="video/mp4" media="(min-width: 768px)" />
          <source src={mobileSrc} type="video/mp4" />
        </video>
      )}

      {/* Honest Architecture Concept Preview — always shown when video is not active */}
      {(!showVideo || prefersReducedMotion) && (
        <div className="absolute inset-0 bg-gradient-to-br from-obsidian-card/95 via-obsidian-elevated/95 to-obsidian-deep/95 flex flex-col justify-between p-4 sm:p-6 font-mono text-xs overflow-hidden">

          {/* Header Bar */}
          <div className="flex items-center justify-between border-b border-titanium-border pb-3">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
              <span className="text-gray-400 text-[11px] ml-2">coderxp-workspace-concept</span>
            </div>
            <div className="flex items-center gap-3 text-gray-400 text-[11px]">
              <span className="flex items-center gap-1 text-gray-400 font-semibold">
                <Cpu className="w-3 h-3" /> Execution Engine (Planned)
              </span>
              <span className="flex items-center gap-1 text-gray-400">
                <Shield className="w-3 h-3" /> BYOK (Planned)
              </span>
            </div>
          </div>

          {/* Architecture Concept Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 my-auto">

            {/* Input & Architecture */}
            <div className="p-3.5 rounded-lg bg-obsidian-deep/90 border border-titanium-border space-y-2">
              <div className="text-accent-cyan flex items-center gap-1.5 text-[11px] font-semibold">
                <Terminal className="w-3.5 h-3.5" /> 1. Input &amp; Architecture
              </div>
              <p className="text-gray-400 text-[11px]">
                Planned: conversation context, project scaffolding, and multimodal input routing.
              </p>
              <div className="pt-2 flex items-center gap-1 text-[11px] text-gray-400">
                <span className="px-1.5 py-0.5 rounded bg-titanium-border/60 text-gray-300">Planned</span>
              </div>
            </div>

            {/* Execution Environment Concept */}
            <div className="p-3.5 rounded-lg bg-obsidian-deep/90 border border-titanium-border space-y-2">
              <div className="text-accent-emerald flex items-center gap-1.5 text-[11px] font-semibold">
                <Shield className="w-3.5 h-3.5" /> 2. Execution Environment Concept
              </div>
              <div className="text-[11px] text-gray-400 space-y-1 font-mono">
                <p className="text-gray-400">Planned: isolated execution containers</p>
                <p className="text-gray-400">Planned: authentic stdout / stderr streams</p>
              </div>
            </div>

            {/* Live Preview Concept */}
            <div className="p-3.5 rounded-lg bg-obsidian-deep/90 border border-titanium-border space-y-2">
              <div className="text-gray-300 flex items-center justify-between text-[11px] font-semibold">
                <span>3. Live Preview</span>
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-titanium-border/60 text-gray-400">Planned</span>
              </div>
              <div className="h-16 rounded bg-obsidian-card border border-titanium-border/60 flex items-center justify-center text-[11px] text-gray-400">
                Preview Runner Isolated iFrame Sandbox
              </div>
            </div>

          </div>

          {/* Bottom Bar */}
          <div className="flex items-center justify-between pt-3 border-t border-titanium-border/60 text-[11px] text-gray-400">
            <span className="flex items-center gap-1.5">
              <ArrowRight className="w-3 h-3" />
              Story Sequence: Idea, Understanding, Planning, Code, Execution, Verification, Live Preview, Share
            </span>
            <span className="font-mono text-gray-400">Product concept preview — functionality not active</span>
          </div>

        </div>
      )}

      {/* Subtle overlay vignette */}
      <div className="absolute inset-0 pointer-events-none bg-gradient-to-t from-obsidian-deep/40 via-transparent to-transparent" />
    </div>
  );
}
