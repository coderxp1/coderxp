"use client";

/**
 * Workspace shell for CoderXP M2/M3 Workspace v2.
 *
 * Provides full 100vh viewport with application-level session authentication.
 */

import React, { useState, useEffect } from "react";
import { useWorkspaceState } from "./hooks/useWorkspaceState";
import { ProjectLauncher } from "./components/ProjectLauncher";
import { ProjectShell } from "./components/ProjectShell";
import { ErrorBanner } from "./components/ErrorBanner";
import { Lock, ArrowRight, AlertCircle, ShieldCheck } from "lucide-react";

export default function WorkspaceShell() {
  const [sessionChecked, setSessionChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [loginIdentifier, setLoginIdentifier] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Check existing session
  useEffect(() => {
    let mounted = true;
    fetch("/api/auth/session")
      .then((res) => res.json())
      .then((data) => {
        if (mounted) {
          setAuthenticated(Boolean(data.authenticated));
          setSessionChecked(true);
        }
      })
      .catch(() => {
        if (mounted) {
          setAuthenticated(false);
          setSessionChecked(true);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginIdentifier || !loginPassword) {
      setLoginError("Please enter your account email/username and password.");
      return;
    }

    setLoginLoading(true);
    setLoginError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginIdentifier, password: loginPassword }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setAuthenticated(true);
      } else {
        setLoginError(data.error || "Invalid credentials. Please try again.");
      }
    } catch {
      setLoginError("Could not reach authentication service.");
    } finally {
      setLoginLoading(false);
    }
  };

  const {
    view,
    projects,
    activeProject,
    activeProjectFiles,
    error,
    creating,
    renaming,
    deleting,
    retrying,
    openingProjectId,
    retryAction,
    creationSuccessVersion,
    renameSuccessVersion,
    handleCreateProject,
    handleRenameProject,
    handleDeleteProject,
    handleProjectUpdate,
    backToLauncher,
    retry,
    dismissError,
    openProjectById,
    refreshActiveProjectFiles,
    fileOperationVersion,
  } = useWorkspaceState();

  const projectOperationPending =
    renaming || deleting || retrying || openingProjectId !== null;

  // 1. Loading session check
  if (!sessionChecked) {
    return (
      <div className="flex items-center justify-center h-screen w-screen bg-[#151617] text-gray-400 text-sm font-mono">
        Verifying session...
      </div>
    );
  }

  // 2. Unauthenticated: Render App Login Screen
  if (!authenticated) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0d0e11] text-gray-200 px-4">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,rgba(59,130,246,0.08),transparent_60%)] pointer-events-none" />

        <div className="relative w-full max-w-md bg-[#16181d] border border-gray-800/80 rounded-2xl shadow-2xl p-8 backdrop-blur-md">
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-12 h-12 rounded-xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-center mb-4 text-blue-400">
              <Lock className="w-6 h-6" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">CoderXP Workspace</h1>
            <p className="text-xs text-gray-400 mt-1">Sign in with your pilot administrator account</p>
          </div>

          {loginError && (
            <div className="mb-6 p-3 rounded-lg bg-red-950/40 border border-red-800/50 flex items-start gap-2.5 text-red-300 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
              <span className="leading-relaxed">{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-300 mb-1.5">
                Account Email or Username
              </label>
              <input
                type="text"
                required
                autoFocus
                value={loginIdentifier}
                onChange={(e) => setLoginIdentifier(e.target.value)}
                placeholder="paul@coderxp.pro or coderxpadmin"
                className="w-full px-3.5 py-2.5 bg-[#0e1015] border border-gray-700/60 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/80 transition"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-300 mb-1.5">
                Password
              </label>
              <input
                type="password"
                required
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full px-3.5 py-2.5 bg-[#0e1015] border border-gray-700/60 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/80 transition"
              />
            </div>

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full mt-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-medium text-sm rounded-lg shadow-lg shadow-blue-600/20 flex items-center justify-center gap-2 transition disabled:opacity-50"
            >
              {loginLoading ? (
                <span className="inline-block animate-pulse">Signing in...</span>
              ) : (
                <>
                  <span>Sign In to Workspace</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-8 pt-6 border-t border-gray-800/60 flex items-center justify-center gap-2 text-gray-500 text-[11px]">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500/70" />
            <span>Session secured via HTTP-only HMAC tokens</span>
          </div>
        </div>
      </div>
    );
  }

  // 3. Authenticated: Render Workspace
  return (
    <div className="h-screen w-screen overflow-hidden bg-[#151617] text-gray-200">
      {view === "loading" && (
        <div className="flex items-center justify-center h-full">
          <p className="text-sm text-gray-500">Loading workspace...</p>
        </div>
      )}

      {view === "error" && error && (
        <div className="flex items-center justify-center h-full">
          <ErrorBanner
            error={error}
            onRetry={retry}
            retrying={retrying}
          />
        </div>
      )}

      {view === "launcher" && (
        <div className="h-full overflow-y-auto">
          {error && retryAction && (
            <ErrorBanner
              error={error}
              onRetry={retry}
              retrying={retrying}
              onDismiss={dismissError}
            />
          )}
          <ProjectLauncher
            projects={projects}
            creating={creating}
            openingProjectId={openingProjectId}
            retrying={retrying}
            creationSuccessVersion={creationSuccessVersion}
            onCreate={handleCreateProject}
            onOpen={openProjectById}
          />
        </div>
      )}

      {view === "project" && activeProject && (
        <div className="flex flex-col h-full overflow-hidden">
          {error && retryAction && (
            <ErrorBanner
              error={error}
              onRetry={retry}
              retrying={retrying}
              onDismiss={dismissError}
            />
          )}
          <ProjectShell
            project={activeProject}
            files={activeProjectFiles}
            renaming={renaming}
            deleting={deleting}
            projectOperationPending={projectOperationPending}
            renameSuccessVersion={renameSuccessVersion}
            fileOperationVersion={fileOperationVersion}
            onBack={backToLauncher}
            onRename={(newName) => handleRenameProject(activeProject.id, newName)}
            onDelete={() => handleDeleteProject(activeProject.id)}
            onProjectUpdate={handleProjectUpdate}
            onRefreshFiles={() => refreshActiveProjectFiles(activeProject.id)}
          />
        </div>
      )}
    </div>
  );
}
