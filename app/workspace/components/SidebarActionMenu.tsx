"use client";

/**
 * Sidebar Action Popover Menu for CoderXP Revision 2.3.
 *
 * Implements Directive §10:
 * - Dropdown anchored to the side-head "+" button
 * - "New session"
 * - "Add MCP server…"
 * - "Bring your own key" submenu with all 9 supported providers
 * - Full ARIA menu roles and keyboard navigation
 */

import React, { useState, useRef, useEffect } from "react";
import {
  BYOK_PROVIDER_DEFS,
  type ByokProviderId,
} from "@/lib/workspace/byok-providers";

export interface SidebarActionMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onNewSession: () => void;
  onOpenMcpModal: () => void;
  onOpenByokModal: (providerId: ByokProviderId) => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export function SidebarActionMenu({
  isOpen,
  onClose,
  onNewSession,
  onOpenMcpModal,
  onOpenByokModal,
}: SidebarActionMenuProps) {
  const [showByokSubmenu, setShowByokSubmenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setShowByokSubmenu(false);
      return;
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }

    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const providers = Object.values(BYOK_PROVIDER_DEFS);

  return (
    <div
      ref={menuRef}
      className="absolute top-[38px] right-[10px] z-50 min-w-[200px] bg-[var(--bg-card)] border border-[var(--border)] rounded-md shadow-xl py-1 text-xs text-[var(--text)] font-sans select-none animate-in fade-in zoom-in-95 duration-100"
      role="menu"
      aria-label="Agent Actions"
    >
      <button
        type="button"
        className="w-full text-left px-3 py-2 hover:bg-[var(--bg-input)] hover:text-[var(--text)] flex items-center gap-2 cursor-pointer transition-colors"
        role="menuitem"
        onClick={() => {
          onNewSession();
          onClose();
        }}
      >
        <svg className="w-3.5 h-3.5 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>New session</span>
      </button>

      <button
        type="button"
        className="w-full text-left px-3 py-2 hover:bg-[var(--bg-input)] hover:text-[var(--text)] flex items-center gap-2 cursor-pointer transition-colors"
        role="menuitem"
        onClick={() => {
          onOpenMcpModal();
          onClose();
        }}
      >
        <svg className="w-3.5 h-3.5 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="2" width="20" height="8" rx="2" />
          <rect x="2" y="14" width="20" height="8" rx="2" />
          <line x1="6" y1="6" x2="6.01" y2="6" />
          <line x1="6" y1="18" x2="6.01" y2="18" />
        </svg>
        <span>Add MCP server…</span>
      </button>

      <div className="h-[1px] bg-[var(--border-soft)] my-1" />

      {/* BYOK Submenu Parent */}
      <div
        className="relative group"
        onMouseEnter={() => setShowByokSubmenu(true)}
        onMouseLeave={() => setShowByokSubmenu(false)}
      >
        <button
          type="button"
          className="w-full text-left px-3 py-2 hover:bg-[var(--bg-input)] hover:text-[var(--text)] flex items-center justify-between cursor-pointer transition-colors"
          role="menuitem"
          aria-haspopup="true"
          aria-expanded={showByokSubmenu}
          onClick={() => setShowByokSubmenu((prev) => !prev)}
        >
          <div className="flex items-center gap-2">
            <svg className="w-3.5 h-3.5 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 2l-2 2m-1.5 1.5L10 13l-4 4-4-4 4-4 7.5-7.5" />
            </svg>
            <span>Bring your own key</span>
          </div>
          <svg className="w-3 h-3 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>

        {/* Submenu */}
        {showByokSubmenu && (
          <div
            className="absolute left-[100%] top-0 ml-1 min-w-[180px] bg-[var(--bg-card)] border border-[var(--border)] rounded-md shadow-xl py-1 z-50 animate-in fade-in duration-75"
            role="menu"
            aria-label="BYOK Providers"
          >
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-input)] hover:text-[var(--text)] flex items-center gap-2 cursor-pointer transition-colors"
                role="menuitem"
                onClick={() => {
                  onOpenByokModal(p.id);
                  onClose();
                }}
              >
                <span>{p.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
