/**
 * WebContainer runtime client for CoderXP.
 *
 * M3.1: boot timeout added. The boot promise races against a configurable
 * timeout. On timeout, the promise rejects with a clear error so callers
 * can surface a retry UI instead of hanging at "mounting" forever.
 *
 * M3.2: boot ownership hardening. The original Promise.race() timeout did
 * not cancel the underlying WebContainer.boot() attempt. If the timeout
 * fired and the user hit Retry, a second boot() could compete with the
 * first. Now, a bootAttemptId token guards against duplicate boot calls:
 * if a boot is in progress, callers receive the same promise. If the boot
 * timed out or failed, the pending promise is fully cleared before a retry
 * is allowed, and the bootAttemptId is incremented so any late resolution
 * from the stale boot is ignored.
 *
 * Binding corrections applied:
 * - COEP mode: require-corp (not credentialless)
 * - Project root: WORKSPACE_PROJECT_ROOT ("project")
 * - Singleton lifecycle: one instance per page lifetime
 * - teardown() reserved for fatal corruption / disposal only
 * - No teardown() during ordinary project switching
 * - Failed boot clears the pending promise and permits retry
 */

import { WebContainer } from "@webcontainer/api";
import { WEBCONTAINER_BOOT_OPTIONS, WORKSPACE_PROJECT_ROOT } from "./constants";

/** Lazy singleton holder for the WebContainer instance. */
let webContainerInstance: WebContainer | null = null;

/** Whether boot() has been called on the current instance. */
let booted = false;

/** Promise tracking an in-progress boot. */
let bootPromise: Promise<WebContainer> | null = null;

/** Boot timeout timer (for cancellation on success). */
let bootTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Monotonic boot attempt ID. Incremented on each new boot attempt.
 * Used to detect and ignore late resolutions from a stale (timed-out) boot.
 */
let bootAttemptId = 0;

/**
 * Boots the WebContainer singleton if not already booted.
 *
 * Uses the binding boot options: coep require-corp,
 * forwardPreviewErrors, workdirName coderxp.
 *
 * M3.1: A configurable boot timeout (default 15s) prevents the boot
 * from hanging indefinitely. On timeout, the promise rejects with a
 * clear error so callers can surface a retry UI.
 *
 * M3.2: Boot ownership hardening. A bootAttemptId token ensures that
 * if a boot times out and the underlying WebContainer.boot() later
 * resolves, that late resolution is ignored. A retry increments the
 * attempt ID, so the stale boot's resolution cannot set state.
 * This prevents competing/duplicate boot attempts.
 *
 * On failure, clears the pending promise and resets state so
 * a later retry is possible. Does not create multiple boot
 * attempts concurrently.
 *
 * @param timeoutMs Boot timeout in milliseconds (default 15000).
 * @returns the booted WebContainer instance
 */
export async function bootWebContainer(timeoutMs: number = 15000): Promise<WebContainer> {
  if (booted && webContainerInstance) {
    return webContainerInstance;
  }

  if (bootPromise) {
    return bootPromise;
  }

  // Assign a new attempt ID for this boot. Any late resolution from
  // a previous (timed-out) boot will have a stale attempt ID and be ignored.
  const attemptId = ++bootAttemptId;

  // Race the boot against a timeout.
  const timeoutPromise = new Promise<never>((_, reject) => {
    bootTimer = setTimeout(() => {
      reject(new Error(`WebContainer boot timed out after ${timeoutMs / 1000}s. The browser environment may not support WebContainers.`));
    }, timeoutMs);
  });

  bootPromise = Promise.race([
    WebContainer.boot(WEBCONTAINER_BOOT_OPTIONS),
    timeoutPromise,
  ])
    .then((instance) => {
      // Ignore late resolutions from a stale (timed-out) boot attempt.
      if (attemptId !== bootAttemptId) {
        // A newer boot attempt has started. Discard this result.
        return webContainerInstance ?? (instance as WebContainer);
      }

      if (bootTimer) {
        clearTimeout(bootTimer);
        bootTimer = null;
      }
      webContainerInstance = instance as WebContainer;
      booted = true;
      return webContainerInstance;
    })
    .catch((error: unknown) => {
      // Only process the error if this is still the current attempt.
      if (attemptId === bootAttemptId) {
        if (bootTimer) {
          clearTimeout(bootTimer);
          bootTimer = null;
        }
        webContainerInstance = null;
        booted = false;
      }
      throw error;
    })
    .finally(() => {
      // Only clear the promise if this is still the current attempt.
      // A newer attempt has its own promise.
      if (attemptId === bootAttemptId) {
        bootPromise = null;
      }
    });

  return bootPromise;
}

/**
 * Tears down the WebContainer singleton.
 *
 * Reserved for:
 * - Fatal runtime corruption
 * - Workspace disposal
 * - A failed instance that cannot be reset
 *
 * Do NOT call this during ordinary project switching.
 */
export function teardownWebContainer(): void {
  // Increment attempt ID so any in-flight boot resolution is ignored.
  bootAttemptId++;

  if (webContainerInstance) {
    webContainerInstance.teardown();
    webContainerInstance = null;
    booted = false;
    bootPromise = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}

/**
 * Removes the project directory from the WebContainer.
 *
 * Called before mounting a new project during project switching.
 */
export async function removeProjectRoot(): Promise<void> {
  if (!webContainerInstance || !booted) return;
  await webContainerInstance.fs.rm(WORKSPACE_PROJECT_ROOT, {
    recursive: true,
    force: true,
  });
}

/** Whether the WebContainer singleton is currently booted. */
export function isBooted(): boolean {
  return booted;
}

/**
 * Returns the shared WebContainer singleton if it is already booted.
 * Does not start a boot. Callers that need the instance without
 * creating a second container (file sync, command tooling) should
 * use this instead of WebContainer.boot().
 */
export function getBootedWebContainer(): WebContainer | null {
  return booted && webContainerInstance ? webContainerInstance : null;
}
