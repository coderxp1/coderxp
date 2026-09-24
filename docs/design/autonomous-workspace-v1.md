# Autonomous Workspace v1 — Architecture & Design Specification

**Document Version:** 1.0.0-draft  
**Status:** Draft for review  
**Target Release:** CoderXP 1.0  
**Author:** Hartmann <jp@coderxp.pro>  
**Reviewers:** Klaus Hoffmann, Core Architecture  

---

## 1. Executive Summary & Core Principles

CoderXP Autonomous Workspace v1 provides an isolated, sandboxed execution environment for multi-turn AI coding agents and human developers. The system bridges browser-based IDE interactions (streaming agent chat, live application preview, terminal sessions) with containerized Linux devboxes, enforcing strict security boundaries, comprehensive resource quotas, and deterministic event sourcing.

### Core Architectural Invariants

* **Fail-Closed Security by Default:** Any missing credential, unverified policy check, network partition, or unreviewed model strictly halts execution rather than falling back to unvetted defaults.
* **Least-Privilege Execution:** Devbox containers execute strictly as unprivileged users (`UID 1000:GID 1000`). Host Docker sockets, host root filesystem, privileged namespaces, and host systemd units are strictly inaccessible.
* **Network & SSRF Isolation:** Containers run on dedicated Docker bridge networks with Inter-Container Communication (ICC) disabled (`icc: false`). Upstream cloud metadata endpoints (`169.254.169.254`), loopback addresses (`127.0.0.1`), and host-internal networks are filtered at the routing boundary.
* **Deterministic Event Sourcing:** Every agent turn, policy evaluation, tool invocation, terminal slice, and filesystem mutation is committed to an append-only, monotonically sequenced event log before action side-effects take place.
* **Verified Teardown:** Terminating an environment requires programmatic verification that processes are killed, mounts unmounted, network interfaces destroyed, and temporary storage scrubbed before releasing resources.

---

## 2. Current Implementation Baseline vs. Target v1 Architecture

To maintain clear separation between what currently runs in the CoderXP codebase and the target v1 design, the following table details current capabilities versus planned architectural deliverables:

| Subsystem / Capability | Current Implementation (Baseline) | Target v1 Design (This Specification) |
| :--- | :--- | :--- |
| **Execution Sandboxing** | Ephemeral Docker containers spawned per workspace using local Docker socket. Container runs as unprivileged user (`UID 1000:GID 1000`). | Rootless container / microVM hybrid model with custom Seccomp and AppArmor profiles, read-only rootfs, and strict user namespaces. |
| **Resource Quotas** | Static memory (`--memory 2g`) and CPU shares (`--cpus 2.0`). No PID limits or disk quotas enforced at runtime. | Enforced hierarchical limits: Per-project CPU quota, hard RAM + swap limit, PID limit (`--pids-limit 256`), and volume quota (10 GB). Aggregate host capacity governor. |
| **Teardown Lifecycle** | Basic `docker stop` and `docker rm -f`. No mount leak detection or network bridge validation. | Multi-stage verified teardown: SIGTERM (10s) -> SIGKILL -> volume scrub -> bridge veth reap -> host verification check. |
| **Agent Tool Authorization** | Ad-hoc checks in tool handlers; basic risk tiers (`ALLOW`, `REQUIRE_APPROVAL`, `DENY`). | Centralized `AuthzGate` middleware routing all agent tool dispatches through deterministic policy rules, tracking approval tokens and audit hashes. |
| **Git Credentials** | BYOK personal access tokens forwarded or stored in user session; potential leak in terminal/agent stream. | Asymmetric deploy keys per repository, ephemeral GitHub App installation tokens (1h lifetime), server-side KMS encryption, zero-leak streaming regex redactor. |
| **Publishing Pipeline** | Basic local preview URL routing via 128-bit slug. | 4 distinct publish adapters: CoderXP Local Deploy, GitHub Push, Vercel API, and Sanitized ZIP export, each with explicit trust boundaries. |
| **Base Images** | Unpinned `node:20-bookworm` or generic templates. | Pinned, content-addressable SHA256 base images per language stack (`node`, `python`, `go`, `rust`), scanned for CVEs with zero runtime package-manager pollution. |
| **Media Generation** | Abstract `IMediaJobService` interface with placeholder mocks. | Dedicated ComfyUI provider connected over localhost tunnel to GPU server (2x RTX PRO 6000 Blackwell, native FLUX schnell & Wan 2.1 nodes). |

---

## 3. Sandboxed Execution & Isolation Model

```mermaid
graph TD
    Client[Browser Client / Web IDE] <-->|TLS / WSS| Nginx[Reverse Proxy]
    Nginx <--> NextCore[CoderXP Core API & Orchestrator]
    
    subgraph "Host Control Boundary (Root / Systemd)"
        NextCore <--> AuthzGate[Agent Tool Authz Engine]
        NextCore <--> Broker[Devbox Broker Service]
        Broker <--> DockerDaemon[Docker Engine / Containerd]
    end

    subgraph "Per-Project Devbox Isolation Sandbox"
        DockerDaemon --> Container[Devbox Container\nUID 1000:1000]
        Container --> RootFS[Read-Only Rootfs\n/usr, /bin, /lib]
        Container --> TmpFS[tmpfs /tmp (noexec, nosuid, 512MB)]
        Container --> WorkVol[Workspace Volume /workspace (rw, 10GB)]
        Container --> PTY[node-pty Shell Process]
    end

    subgraph "GPU Cluster via Tunnel (Out of Scope for Devbox)"
        NextCore -.->|IMediaJobService\n127.0.0.1:8188 Tunnel| ComfyUI[ComfyUI 0.36.0\nRTX PRO 6000 Blackwell]
    end
```

### 3.1 Container & MicroVM Boundaries

1. **User Namespaces & Unprivileged Execution:**
   - Devbox execution processes run under dedicated user namespaces (`userns-remap`). Inside the container, processes run as `UID 1000:GID 1000` (`coderxp-user`).
   - Root in the container maps to an unprivileged high UID (`e.g., UID 100000`) on the host, preventing host kernel privilege escalation.
2. **Filesystem Mounts & Read-Only Rootfs:**
   - Root filesystem (`/`) is mounted **read-only** (`--read-only`). System directories (`/usr`, `/etc`, `/bin`, `/sbin`) cannot be altered by malicious scripts or runaway agent loops.
   - Ephemeral temporary directories (`/tmp`, `/run`) are mounted as memory-backed `tmpfs` mounts with strict flags: `nosuid`, `nodev`, `size=512m`.
   - The workspace directory (`/workspace`) is mounted as a dedicated Docker volume owned strictly by `1000:1000` with `noexec` disabled only if script compilation is required, while protecting git metadata.
3. **Seccomp & AppArmor Confinement:**
   - **Seccomp Profile:** Disallows dangerous syscalls: `clone` with new user namespaces (`CLONE_NEWUSER`), `ptrace`, `bpf`, `sys_chroot`, `kexec_load`, `mount`, `pivot_root`, `reboot`, and raw socket generation (`AF_NETLINK`, `AF_PACKET`).
   - **AppArmor Profile:** Enforces path-level restrictions preventing access to `/proc/kcore`, `/proc/sysrq-trigger`, `/sys/firmware`, and `/dev/kmsg`.
4. **Network Containment:**
   - Dedicated Docker bridge per project (`coderxp-net-<project-id>`).
   - Bridge created with `--opt com.docker.network.bridge.enable_icc=false` to prevent cross-container snooping.
   - Firewall rules drop outbound traffic targeting cloud metadata IPs (`169.254.169.254`), loopback ranges (`127.0.0.0/8`), and internal infrastructure RFC-1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).

---

## 4. Quotas & Host Aggregate Limits

To prevent resource exhaustion, fork-bombs, and noisy-neighbor interference, CoderXP implements hierarchical quotas:

### 4.1 Per-Project Limits

| Metric | Free Tier Limit | Pro / Enterprise Limit | Enforcement Mechanism |
| :--- | :--- | :--- | :--- |
| **CPU Allocation** | 0.5 CPU cores (`--cpus=0.5`) | 2.0 CPU cores (`--cpus=2.0`) | CFS bandwidth limiter (`cpu.cfs_quota_us`) |
| **Memory Limit** | 512 MB | 2048 MB | Hard cgroup limit (`memory.max`). OOM-killer terminates container process if exceeded. |
| **Swap Limit** | 0 MB (`--memory-swap=512m`) | 0 MB (`--memory-swap=2048m`) | Swap disabled to protect host disk I/O. |
| **PID Limit** | 128 PIDs (`--pids-limit=128`) | 256 PIDs (`--pids-limit=256`) | Cgroups pids controller (`pids.max`) defeating fork bombs. |
| **Disk Workspace** | 2 GB storage | 10 GB storage | XFS project quota or Docker volume size limits. |
| **Session Lifetime** | 30 minutes idle timeout | 120 minutes idle timeout | Automated idle process monitor terminating inactive sessions. |

### 4.2 Host Aggregate Capacity Governor

The host devbox broker monitors aggregate resource consumption across all active containers:
- **Maximum Active Devboxes:** Strictly capped at `min(Floor(Total_Host_RAM / 2GB) - 4, Max_Host_CPU * 2)`. On a 64 GB host, maximum concurrent active devboxes = 28.
- **CPU Headroom Reservation:** Host reserves a minimum of 2 dedicated CPU cores and 8 GB RAM exclusively for Nginx, Next.js server, Docker daemon, and monitoring agents.
- **Admission Control:** If aggregate host memory allocation exceeds 80% or host load average exceeds 1.5x core count, new devbox launch requests are queued or rejected with HTTP 503 (`CapacityExceededError`).

---

## 5. Verified Teardown Lifecycle

Teardown must be atomic, leak-free, and verifiable. The teardown state machine executes as follows:

```mermaid
sequenceDiagram
    participant Orch as Orchestrator / Broker
    participant Cont as Devbox Container
    participant Dock as Docker Engine
    participant Host as Host Linux System

    Orch->>Cont: 1. Send SIGTERM to process group
    Note over Cont: Grace period (10 seconds)
    alt Processes gracefully terminate
        Cont-->>Orch: Clean process exit
    else Grace period expires
        Orch->>Cont: 2. Send SIGKILL to container cgroup
    end
    Orch->>Dock: 3. Stop container & unmount volumes
    Orch->>Dock: 4. Remove container (docker rm -f)
    Orch->>Host: 5. Verify mount unlinking (/proc/mounts)
    Orch->>Host: 6. Remove veth pair & network bridge
    Orch->>Host: 7. Scrub temporary scratch dirs & tokens
    Orch-->>Orch: 8. Transition state to DESTROYED in EventStore
```

### Teardown Invariants
1. **Mount Leak Prevention:** The broker reads `/proc/mounts` or executes `findmnt` targeting the container ID to confirm that all volume mounts have unmounted. If a volume remains busy, `fuser -km` is invoked before force unmounting.
2. **Network Interface Cleanup:** The broker verifies that the virtual ethernet pair (`veth*`) allocated to the container is pruned from the host network namespace.
3. **Audit Confirmation:** A workspace is not marked as `DESTROYED` until all verification checks pass. If verification fails, it enters a `TEARDOWN_FAULT` state triggering operator alerts.

---

## 6. Agent Tool Routing & Authorization Architecture

All agent tool dispatches (file reading, writing, terminal command execution, network requests) must pass through an authorization middleware (`AuthzGate`) before reaching the devbox broker.

### 6.1 Policy Risk Tiers

```mermaid
graph LR
    ToolCall[Agent Tool Call Request] --> Classifier{Risk Classifier}
    Classifier -->|Safe / Read-Only| Allow[ALLOW: Direct Execution]
    Classifier -->|Guarded / Mutating| Approval[REQUIRE_APPROVAL: Human Gate]
    Classifier -->|Forbidden / Dangerous| Deny[DENY: Immediate Rejection]
```

1. **`ALLOW` (Autonomous Execution):**
   - Workspace file reads (`cat`, `view_file`).
   - Project directory listings (`ls`, `find_by_name`).
   - Read-only diagnostics (`git status`, `git log`, `npm test` dry-run).
2. **`REQUIRE_APPROVAL` (Human-in-the-Loop Approval Required):**
   - Writing/editing source files outside established diff scope.
   - Installing new dependencies (`npm install <pkg>`, `pip install <pkg>`).
   - Binding listening ports (`3000-8999`).
   - Non-destructive git mutations (`git commit`, `git checkout -b`).
3. **`DENY` (Hard Block — Unconditional Failure):**
   - Privilege escalation (`sudo`, `su`, `doas`, `setuid`).
   - Raw device or kernel filesystem manipulation (`dd`, `mknod`, writes to `/proc`, `/sys`, `/dev`).
   - Access to container runtime sockets (`/var/run/docker.sock`).
   - Network calls to link-local/cloud metadata IPs (`169.254.169.254`, `127.0.0.1` host ports).
   - Destructive recursive deletions (`rm -rf /`, `rm -rf /workspace`).

---

## 7. Git Credentials Management & Redaction

### 7.1 Deploy Keys vs. GitHub App Installation Tokens

CoderXP strictly avoids storing personal user passwords or personal access tokens (PATs) in devbox workspaces.

| Dimension | Deploy Keys (SSH) | GitHub App Installation Tokens |
| :--- | :--- | :--- |
| **Scope** | Single repository only. Zero cross-repository reach. | Scoped strictly to repositories selected during App installation. |
| **Privilege Granularity** | Read-Only or Read-Write on git push/pull. | Fine-grained permissions (Contents: Read/Write, Pull Requests: Write). |
| **Lifetime & Rotation** | Long-lived until revoked; rotated every 90 days. | Short-lived: 1 hour maximum lifetime. Minted dynamically on-demand. |
| **Recommended Use Case** | Dedicated long-running staging devboxes. | Multi-tenant user workspaces and automated agent PR generation. |

### 7.2 Storage & Streaming Redaction
- **KMS / Server-Side Encryption:** Credentials are encrypted at rest using AES-256-GCM with keys managed by the host environment (`AUTH_SESSION_SECRET` / server KMS).
- **No Disk Persistence in Devbox:** Credentials are never written to `/workspace/.git/config` as plaintext tokens. Instead, git operations authenticate via an ephemeral credential helper or SSH agent forwarding managed by the broker.
- **Streaming Output Redaction:** Terminal streams and agent event logs pass through real-time regex redaction buffers that mask GitHub tokens (`ghp_[A-Za-z0-9_]{36}`, `ghs_[A-Za-z0-9_]{36}`), SSH private keys (`-----BEGIN OPENSSH PRIVATE KEY-----`), and provider API keys before transmission to the browser client or event store.

---

## 8. Publishing Adapters & Trust Boundaries

CoderXP supports four distinct deployment and export targets. Each operates within an isolated trust boundary:

```mermaid
graph TD
    Workspace[Sanitized Workspace Files] --> AdapterRouter{Publish Adapter Router}
    AdapterRouter -->|1. Local Host| CoderxpDeploy[CoderXP Preview Deploy\nPrivate Container Port]
    AdapterRouter -->|2. GitHub| GitHubPush[GitHub Push Adapter\nEphemeral App Token]
    AdapterRouter -->|3. Vercel| VercelDeploy[Vercel API Adapter\nScoped Deploy Token]
    AdapterRouter -->|4. Archive| ZipExport[Sanitized ZIP Export\nStateless Stream]
```

1. **CoderXP Local Deploy:**
   - Deploys the built application directly into a preview container within the CoderXP hosting perimeter.
   - Authenticated via cryptographically random 128-bit preview slugs.
   - Bound strictly to internal private IP routing; completely inaccessible from external networks without session auth.
2. **GitHub Push Adapter:**
   - Pushes commits or creates Pull Requests against the upstream repository.
   - Authenticated exclusively via short-lived GitHub App installation tokens.
   - Trust boundary: Only sanitized commit trees are pushed; `.env` files, secrets, and transient devbox artifacts are filtered via strict `.gitignore` enforcement.
3. **Vercel API Deploy Adapter:**
   - Deploys frontend web applications via Vercel's REST API.
   - Authenticated via user-supplied, scoped Vercel deployment tokens held ephemerally in server memory.
   - Validates build output prior to upload, stripping server configuration files and local secrets.
4. **Sanitized ZIP Export:**
   - Bundles the workspace into a downloadable `.zip` archive for local extraction.
   - Deterministic filtering strips `.git/` credentials, `node_modules/`, `.env*` secret files, and build cache directories.
   - Generated statelessly in streaming memory with zero temporary disk persistence on the host.

---

## 9. Pinned Per-Stack Base Images

To prevent supply-chain drift, build instability, and runtime poisoning, CoderXP disallows dynamic `latest` tags. All devbox base images are pinned by exact cryptographic SHA256 digest:

* **Node.js Stack:** `ghcr.io/coderxp/devbox-node:20.18-bookworm@sha256:7f3b891a...`
  - Includes Node.js 20 LTS, pnpm, yarn, npm, Git, curl, jq.
* **Python Stack:** `ghcr.io/coderxp/devbox-python:3.11-slim-bookworm@sha256:9c4d210b...`
  - Includes Python 3.11, pip, uv, virtualenv, build-essential.
* **Go Stack:** `ghcr.io/coderxp/devbox-go:1.23-bookworm@sha256:1a8e329f...`
  - Includes Go 1.23, git, gcc, libc6-dev.
* **Rust Stack:** `ghcr.io/coderxp/devbox-rust:1.82-bookworm@sha256:4b22108c...`
  - Includes Rust 1.82, cargo, rustc, mold linker.

Images are audited weekly with automated CVE scanners (Trivy/Grype). Base images never contain compiler build-tools or root utilities that are unnecessary for runtime development.

---

## 10. Dedicated GPU Infrastructure & Media Service Topology

Media generation capabilities are decoupled from devbox compute and provided by a dedicated GPU cluster via the `IMediaJobService` contract:

* **Host Machine:** Dedicated GPU Server (`45.84.65.76`).
* **Hardware Configuration:** 2x NVIDIA RTX PRO 6000 Blackwell Server Edition (96 GB VRAM each).
  - **GPU 0 (`cuda:0`):** Exclusively dedicated to ComfyUI media generation workflows.
  - **GPU 1 (`cuda:1`):** Reserved for future multi-agent workspace acceleration.
* **Software Stack:** ComfyUI 0.36.0 (git commit `ee71d5c`), Python 3.11, PyTorch `2.9.1+cu128`.
* **Network & Security Boundary:**
  - The ComfyUI service has **no outbound internet access** (`no internet egress`).
  - No custom unverified nodes; all pipelines execute purely via native ComfyUI nodes.
  - No runtime model downloads. All model weights are pre-loaded and immutable:
    - `flux1-schnell-fp8.safetensors` via `CheckpointLoaderSimple`
    - `wan2.1_t2v_1.3B_fp16.safetensors` via `UNETLoader`
    - `umt5_xxl_fp8_e4m3fn_scaled.safetensors` via `CLIPLoader` (type: `wan`)
    - `wan_2.1_vae.safetensors` via `VAELoader`
  - Devboxes connect to ComfyUI **exclusively via localhost tunnel** (`http://127.0.0.1:8188`). ComfyUI host details, physical topology, and GPU management are entirely out of scope for the devbox runtime.

---

## 11. Implementation Phasing & Non-Goals

### 11.1 Phasing Roadmap

1. **Phase 1 (Immediate / CoderXP 1.0):**
   - Containerized Docker sandboxes with unprivileged execution (`UID 1000:GID 1000`).
   - Read-only rootfs with memory-backed tmpfs.
   - Resource quotas (CPU, RAM, PID limits).
   - Centralized `AuthzGate` for all agent tool dispatches.
   - Verified teardown sequence and mount leak detection.
   - Localhost tunnel integration with dedicated ComfyUI GPU server.
2. **Phase 2 (CoderXP 1.1):**
   - MicroVM hypervisor evaluation (Firecracker / Cloud-Hypervisor) for multi-tenant isolation.
   - Ephemeral GitHub App installation token integration.
   - Vercel and GitHub publish adapters.
   - Fine-grained per-project XFS storage quotas.
3. **Phase 3 (CoderXP 2.0):**
   - Distributed multi-host devbox cluster with Kubernetes/Nomad orchestration.
   - Dynamic GPU allocation for devboxes requiring local CUDA compute.

### 11.2 Explicit Non-Goals

* **Arbitrary Host Root Access:** CoderXP will never provide sudo, root shells, or host namespace access to devbox users or autonomous agents.
* **Docker-in-Docker (DinD):** Running nested unconfined Docker engines inside devboxes is explicitly rejected due to root-equivalence and kernel security risks.
* **Dynamic Model Downloads on GPU Workers:** The GPU cluster will not download models on-the-fly during job requests. All models must be pre-baked into verified storage.
* **Unauthenticated Public Preview Tunnels:** Devbox preview URLs will never expose unauthenticated public endpoints without session validation or explicit 128-bit preview slugs.
