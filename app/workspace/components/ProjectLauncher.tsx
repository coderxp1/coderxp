"use client";

/**
 * Project launcher for CoderXP M2 Workspace Alpha.
 *
 * Final correction scope:
 * - Project name input clears only after successful project creation.
 * - Selected template is preserved on failure.
 * - Opening is disabled while another project is opening (openingProjectId).
 * - Creation is disabled while opening.
 * - Shows "Opening..." on the actual project being opened.
 *
 * Visual style:
 * - Obsidian/graphite background
 * - Warm-white text
 * - Subtle cyan accents
 * - Professional SVG icons through Lucide
 * - No emoji, no purple/magenta AI styling, no oversized gradients, no fake terminal
 *
 * Features:
 * - "New project" action
 * - Project name field
 * - Template cards (static-html available, react-ts and nextjs-ts unavailable)
 * - Existing local projects ordered predictably (oldest first)
 * - Last-updated information using real stored timestamps
 * - Creating disabled while transaction is pending
 */

import { useState } from "react";
import { FileCode2, FolderPlus, Lock, Clock, Layers } from "lucide-react";
import { TEMPLATE_METADATA } from "@/lib/workspace/templates";
import type { WorkspaceProject, ProjectTemplateId } from "@/lib/workspace/types";

interface ProjectLauncherProps {
  projects: WorkspaceProject[];
  creating: boolean;
  openingProjectId: string | null;
  retrying: boolean;
  creationSuccessVersion: number;
  onCreate: (name: string, templateId: ProjectTemplateId) => Promise<boolean>;
  onOpen: (projectId: string) => void;
}

export function ProjectLauncher({ projects, creating, openingProjectId, retrying, creationSuccessVersion, onCreate, onOpen }: ProjectLauncherProps) {
  const [name, setName] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<ProjectTemplateId>("static-html");

  // Clear the name input when creation succeeds (including on retry).
  // Uses the monotonic creationSuccessVersion token so we detect success
  // without matching project names (duplicate names are allowed).
  // Adjusting state during render is the React-recommended pattern for
  // syncing local state to a changing prop/external signal.
  const [lastSeenVersion, setLastSeenVersion] = useState(creationSuccessVersion);
  if (creationSuccessVersion !== lastSeenVersion) {
    setLastSeenVersion(creationSuccessVersion);
    setName("");
  }

  // Creation is disabled while creating or while a project is opening.
  const canCreate = name.trim().length > 0 && !creating && openingProjectId === null && !retrying;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;

    // The name input is cleared by the creationSuccessVersion effect
    // after successful creation. On failure, the entered project name
    // and selected template are preserved.
    await onCreate(name, selectedTemplate);
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="min-h-[60vh] py-8 px-6 max-w-4xl mx-auto">
      {/* New project section */}
      <div className="mb-10">
        <h2 className="text-lg font-semibold text-gray-100 mb-4 flex items-center gap-2">
          <FolderPlus className="w-5 h-5 text-cyan-500" />
          New project
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="project-name" className="block text-sm text-gray-400 mb-1.5">
              Project name
            </label>
            <input
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              disabled={creating || openingProjectId !== null || retrying}
              placeholder="My static site"
              className="w-full max-w-md px-3 py-2 text-sm text-gray-100 bg-gray-900 border border-gray-700 rounded-md focus:outline-none focus:border-cyan-600 transition-colors disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">Template</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl">
              {TEMPLATE_METADATA.map((template) => {
                const isAvailable = template.available;
                const isSelected = selectedTemplate === template.id;
                return (
                  <button
                    key={template.id}
                    type="button"
                    disabled={!isAvailable || creating || openingProjectId !== null || retrying}
                    onClick={() => isAvailable && setSelectedTemplate(template.id)}
                    className={`relative p-4 text-left rounded-lg border transition-all ${
                      isSelected && isAvailable
                        ? "border-cyan-600 bg-cyan-950/20"
                        : isAvailable
                          ? "border-gray-700 bg-gray-900 hover:border-gray-600"
                          : "border-gray-800 bg-gray-900/50 cursor-not-allowed"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Layers className={`w-4 h-4 ${isAvailable ? "text-cyan-500" : "text-gray-600"}`} />
                      <span className={`text-sm font-medium ${isAvailable ? "text-gray-100" : "text-gray-500"}`}>
                        {template.name}
                      </span>
                    </div>
                    {!isAvailable && (
                      <div className="flex items-center gap-1.5 text-xs text-gray-600">
                        <Lock className="w-3 h-3" />
                        {template.unavailableReason ?? "Unavailable"}
                      </div>
                    )}
                    {isAvailable && (
                      <div className="text-xs text-gray-500">
                        {template.id === "react-ts"
                          ? "React, TypeScript, Vite"
                          : template.id === "nextjs-ts"
                            ? "Next.js, TypeScript, App Router"
                            : "HTML, CSS, JavaScript"}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            type="submit"
            disabled={!canCreate}
            className="px-5 py-2 text-sm font-medium text-white bg-cyan-700 rounded-md hover:bg-cyan-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {creating ? "Creating..." : "Create project"}
          </button>
        </form>
      </div>

      {/* Existing projects */}
      <div>
        <h2 className="text-lg font-semibold text-gray-100 mb-4 flex items-center gap-2">
          <FileCode2 className="w-5 h-5 text-cyan-500" />
          Your projects
        </h2>

        {projects.length === 0 ? (
          <p className="text-sm text-gray-500 italic">No projects yet. Create one above to get started.</p>
        ) : (
          <div className="space-y-2">
            {projects.map((project) => {
              const isOpening = openingProjectId === project.id;
              const isDisabled = openingProjectId !== null || creating || retrying;
              return (
                <button
                  key={project.id}
                  onClick={() => onOpen(project.id)}
                  disabled={isDisabled}
                  className={`flex items-center justify-between w-full px-4 py-3 text-left rounded-lg border transition-all ${
                    isOpening
                      ? "border-cyan-600 bg-cyan-950/20"
                      : isDisabled
                        ? "border-gray-800 bg-gray-900/50 cursor-not-allowed opacity-60"
                        : "border-gray-700 bg-gray-900 hover:border-gray-600"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <FileCode2 className="w-4 h-4 text-gray-500" />
                    <div>
                      <div className="text-sm text-gray-100 font-medium">{project.name}</div>
                      <div className="text-xs text-gray-500">
                        {project.templateId === "static-html"
                          ? "Static HTML"
                          : project.templateId === "react-ts"
                            ? "React + TypeScript"
                            : project.templateId === "nextjs-ts"
                              ? "Next.js + TypeScript"
                              : project.templateId}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-gray-600">
                    {isOpening ? (
                      <span className="text-cyan-400">Opening...</span>
                    ) : (
                      <>
                        <Clock className="w-3 h-3" />
                        {formatDate(project.updatedAt)}
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
