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
* **Network & SSRF Isolation:** Containers run on dedicated Docker bridge networks with Inter-Container Communication (ICC) disabled (`icc: false`). Upstream cloud metadata endpoints (`169.254.169.254`), loopback addresses (`127.0.0.1`), and host-internal networks are filtered at the routing boundary. Devboxes never communicate directly with internal AI or media endpoints.
* **Deterministic Event Sourcing:** Every agent turn, policy evaluation, tool invocation, terminal slice, and filesystem mutation is committed to an append-only, monotonically sequenced event log before action side-effects take place.
* **Verified Teardown:** Terminating an environment requires programmatic verification that processes are killed, mounts unmounted, network interfaces destroyed, and temporary storage scrubbed before releasing resources.

---

## 2. Current Implementation Baseline vs. Target v1 Architecture

To maintain complete rigor and transparency regarding current codebase capabilities versus planned v1 architecture, the table below provides direct file and line references in `main` (`414f34a`) for all current baseline claims, clearly marking unbuilt functionality:

| Subsystem / Capability | Current Implementation (`main` @ `414f34a`) | Target v1 Design (This Specification) |
| :--- | :--- | :--- |
| **Execution Sandboxing** | Ephemeral Docker containers spawned as unprivileged user (`UID 1000:GID 1000`) via `lib/server/devbox-broker.ts:90-91,106`. Basic security flag `--security-opt no-new-privileges:true` (`lib/server/devbox-broker.ts:86-87`). Read-only rootfs, custom seccomp profiles, and AppArmor confinement are **not implemented**. | **Phase 1:** Hardened Docker containers with read-only rootfs (`--read-only`), ephemeral `tmpfs /tmp`, strict user namespaces (`userns-remap`), and custom Seccomp/AppArmor syscall profiles. **Phase 2:** MicroVM hypervisor evaluation (Firecracker / Cloud-Hypervisor). |
| **Resource Quotas** | Static container flags: `--cpus 2.0` (`lib/server/devbox-broker.ts:78-79`), `--memory 3g` (`lib/server/devbox-broker.ts:80-81`), `--memory-swap 3g` (`lib/server/devbox-broker.ts:82-83`), `--pids-limit 256` (`lib/server/devbox-broker.ts:84-85`), and session config `memoryBytes: 2GB` (`lib/server/devbox-broker.ts:208`). Disk volume quotas and host aggregate admission governors are **not implemented**. | Hierarchical quotas: Enforced per-tier limits (Free: 0.5 CPU, 512 MB RAM, 128 PIDs, 2 GB disk; Pro: 2.0 CPU, 2048 MB RAM, 256 PIDs, 10 GB disk). Host admission controller dynamically bounding active containers based on host capacity. |
| **Teardown Lifecycle** | Container removal via `docker rm -f` (`lib/server/devbox-broker.ts:285`) and session purge (`lib/server/devbox-broker.ts:420-440`). Leak detection for `/proc/mounts`, zombie PID sweeping, and veth bridge pruning are **not implemented**. | Multi-stage verified teardown state machine: SIGTERM (10s) -> SIGKILL -> volume unmount & audit via `/proc/mounts` -> veth interface pruning -> state transition to `DESTROYED`. |
| **Agent Tool Authorization** | 5-tier action policy (`T0` to `T4`) in `lib/devbox/action-policy.ts:20-136` gating git push and destructive commands. Runtime pauses on `awaiting-approval` in `lib/workspace/agent-execution-runtime.ts:43,455-465`. The 3-tier `ALLOW`/`REQUIRE_APPROVAL`/`DENY` taxonomy and centralized `AuthzGate` middleware are **not implemented**. | Centralized `AuthzGate` intercepting 100% of agent tool dispatches across all tools (filesystem, shell, network, git) through standardized risk classification with audit token logging. |
| **Git Credentials** | Session-gated approval checks in `lib/server/devbox-credential-gate.ts:22-75`. Streaming secret scrubber masks keys in `lib/workspace/secrets.ts:50-120`. Ephemeral GitHub App tokens, asymmetric deploy key management, and isolated credential helpers are **not implemented**. | Isolated broker credential helper supplying short-lived GitHub App tokens (1h lifetime) or per-repo deploy keys on-demand. Plaintext tokens never touch container disk. Dedicated encryption key (`CREDENTIALS_ENCRYPTION_KEY`). |
| **Publishing Pipeline** | Live preview URL routing via 128-bit hex slug in `lib/server/preview-link-store.ts:24-45` and `lib/server/preview-router.ts:50-100`. External publish adapters (GitHub Push, Vercel, ZIP export) are **not implemented**. | 4 independent publish adapters (CoderXP Preview Deploy, GitHub Push, Vercel API, Sanitized ZIP export) with explicit trust boundaries and automated secret stripping. |
| **Base Images** | Unpinned generic image tag `coderxp-devbox:latest` referenced directly in `lib/server/devbox-broker.ts:100`. Per-stack pinned images are **not implemented**. | Immutable, build-time digest-pinned base images per stack (`node:22-bookworm-slim`, `python:3.11-slim-bookworm`, `golang:1.23-bookworm`, `rust:1.82-slim-bookworm`) with exact SHA256 digests tracked in repo. |
| **Media Generation** | Abstract interfaces `IMediaJobService`, `MediaGenerationRequest`, and `JobRecord` defined in `lib/server/providers/types.ts:140-205`. Concrete ComfyUI provider is **not implemented**. | Production `ComfyUiMediaJobService` called exclusively by CoderXP server over localhost tunnel (`127.0.0.1:8188`) targeting ComfyUI 0.36.0 on dedicated RTX PRO 6000 Blackwell GPU. Devbox has zero direct access. |

---

## 3. Sandboxed Execution & Isolation Model

```mermaid
graph TD
    Client[Browser Client / Web IDE] <-->|TLS / WSS| Nginx[Reverse Proxy]
    Nginx <--> NextCore[CoderXP Core API & Server]
    
    subgraph "Server Host Control Boundary"
        NextCore <--> AuthzGate[Agent Tool Authz Engine]
        NextCore <--> Broker[Devbox Broker Service]
        Broker <--> DockerDaemon[Docker Engine / Containerd]
        NextCore -.->|COMFYUI_URL\n127.0.0.1:8188 Tunnel| ComfyUI[ComfyUI 0.36.0\nRTX PRO 6000 Blackwell]
    end

    subgraph "Per-Project Devbox Isolation Sandbox"
        DockerDaemon --> Container[Devbox Container\nUID 1000:1000]
        Container --> RootFS[Read-Only Rootfs\n/usr, /bin, /lib]
        Container --> TmpFS[tmpfs /tmp (noexec, nosuid, 512MB)]
        Container --> WorkVol[Workspace Volume /workspace (rw, 10GB)]
        Container --> PTY[node-pty Shell Process]
    end
```

### 3.1 Container Isolation Boundaries

1. **User Namespaces & Unprivileged Execution:**
   - Devbox processes run under user namespace remapping (`userns-remap`). Inside the container, processes execute strictly as `UID 1000:GID 1000` (`coderxp-user`).
   - Root in the container maps to an unprivileged high UID (e.g., `UID 100000`) on the host. Host `/etc/passwd`, `/etc/shadow`, and privileged namespaces are completely invisible.
2. **Filesystem Mounts & Read-Only Rootfs:**
   - Root filesystem (`/`) is mounted **read-only** (`--read-only`). System binaries (`/usr`, `/bin`, `/lib`) cannot be modified or replaced.
   - Ephemeral temporary storage (`/tmp`, `/run`) is mounted as memory-backed `tmpfs` mounts with flags: `nosuid`, `nodev`, `size=512m`.
   - The workspace directory (`/workspace`) is backed by a dedicated Docker volume owned by `1000:1000`.
3. **Seccomp & AppArmor Confinement:**
   - **Seccomp Profile:** Disallows dangerous syscalls: `clone` with new user namespaces (`CLONE_NEWUSER`), `ptrace`, `bpf`, `sys_chroot`, `kexec_load`, `mount`, `pivot_root`, `reboot`, and raw packet sockets (`AF_PACKET`, `AF_NETLINK`).
   - **AppArmor Profile:** Blocks path traversals to host devices and kernel state (`/proc/kcore`, `/proc/sysrq-trigger`, `/sys/firmware`, `/dev/kmsg`).
4. **Network Containment & SSRF Guard:**
   - Dedicated Docker bridge per project (`coderxp-net-<project-id>`) with Inter-Container Communication disabled (`--opt com.docker.network.bridge.enable_icc=false`).
   - Firewall rules unconditionally drop outbound packets targeting cloud metadata IPs (`169.254.169.254`), loopback ranges (`127.0.0.0/8`), and internal RFC-1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
   - **Zero Devbox Access to ComfyUI:** Devboxes cannot reach `127.0.0.1:8188` or the GPU server tunnel. All media requests route through the CoderXP server via `IMediaJobService`.

---

## 4. Quotas & Host Aggregate Limits

### 4.1 Per-Project Limits

| Metric | Free Tier Limit | Pro / Enterprise Limit | Enforcement Mechanism |
| :--- | :--- | :--- | :--- |
| **CPU Allocation** | 0.5 CPU cores (`--cpus=0.5`) | 2.0 CPU cores (`--cpus=2.0`) | CFS bandwidth quota (`cpu.cfs_quota_us`) |
| **Memory Limit** | 512 MB | 2048 MB | Hard cgroup limit (`memory.max`). OOM-killer terminates container if exceeded. |
| **Swap Limit** | 0 MB (`--memory-swap=512m`) | 0 MB (`--memory-swap=2048m`) | Swap disabled to protect host NVMe I/O. |
| **PID Limit** | 128 PIDs (`--pids-limit=128`) | 256 PIDs (`--pids-limit=256`) | Cgroups pids controller (`pids.max`) defeating fork-bombs. |
| **Disk Workspace** | 2 GB storage | 10 GB storage | XFS project quotas or Docker volume size limits. |
| **Session Lifetime** | 30 minutes idle timeout | 120 minutes idle timeout | Automated idle process monitor terminating inactive sessions. |

### 4.2 Host Aggregate Capacity Governor

On the production server host (48 CPU cores, 188 GB RAM, 2x NVIDIA RTX PRO 6000 Blackwell GPUs):
- **Resource Reservation:** Host reserves 8 CPU cores and 32 GB RAM exclusively for Nginx reverse proxy, Next.js server, Docker daemon, systemd services, and SSH tunnel routing.
- **Compute Pool Allocation:** 40 CPU cores and 156 GB RAM are allocated for devbox containers.
- **Maximum Active Devboxes:** Strictly capped at `min(Floor(156 GB / 2.0 GB), 40 cores * 2) = 78 concurrent Pro devboxes` (or up to 150 mixed Free/Pro devboxes).
- **GPU Allocation Boundary:**
  - **GPU 0 (`cuda:0`):** Exclusively reserved for the ComfyUI media provider service (96 GB VRAM).
  - **GPU 1 (`cuda:1`):** Completely reserved for future development workspaces and agent workloads. Devbox containers in Phase 1 have zero access to GPU 0 or GPU 1.
- **Admission Control:** If aggregate host memory allocation exceeds 80% or load average exceeds 1.5x core count (72.0), new devbox launch requests fail closed with HTTP 503 (`CapacityExceededError`).

---

## 5. Verified Teardown Lifecycle

Teardown must be atomic, leak-free, and verifiable:

```mermaid
sequenceDiagram
    participant Orch as Orchestrator / Broker
    participant Cont as Devbox Container
    participant Dock as Docker Engine
    participant Host as Host Linux System

    Orch->>Cont: 1. Send SIGTERM to container process group
    Note over Cont: Grace period (10 seconds)
    alt Processes exit cleanly
        Cont-->>Orch: Clean process exit
    else Grace period expires
        Orch->>Cont: 2. Send SIGKILL to container cgroup
    end
    Orch->>Dock: 3. Stop container & unmount volumes
    Orch->>Dock: 4. Remove container (docker rm -f)
    Orch->>Host: 5. Verify mount unlinking (/proc/mounts)
    Orch->>Host: 6. Remove veth pair & network bridge
    Orch->>Host: 7. Scrub ephemeral storage & tokens
    Orch-->>Orch: 8. Record DESTROYED state in EventStore
```

### Teardown Invariants
1. **Mount Leak Prevention:** The broker inspects `/proc/mounts` or executes `findmnt` targeting the container ID to confirm all volume mounts have unmounted. If a mount remains busy, `fuser -km` is invoked before force unmounting.
2. **Network Interface Cleanup:** The broker verifies the virtual ethernet interface (`veth*`) is pruned from the host network namespace.
3. **Audit Confirmation:** A workspace is not marked as `DESTROYED` until all verification checks pass. If verification fails, it enters a `TEARDOWN_FAULT` state triggering operator alerts.

---

## 6. Agent Tool Routing & Authorization Architecture

All agent tool dispatches must pass through the `AuthzGate` middleware before execution:

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
2. **`REQUIRE_APPROVAL` (Human-in-the-Loop Gate):**
   - Writing/editing source files outside established diff scope.
   - Installing dependencies (`npm install <pkg>`, `pip install <pkg>`).
   - Binding listening ports (`3000-8999`).
   - Non-destructive git mutations (`git commit`, `git checkout -b`).
3. **`DENY` (Hard Block — Immediate Rejection):**
   - Privilege escalation (`sudo`, `su`, `doas`, `setuid`).
   - Raw device or kernel filesystem manipulation (`dd`, `mknod`, writes to `/proc`, `/sys`, `/dev`).
   - Access to container runtime sockets (`/var/run/docker.sock`).
   - Network calls to link-local/cloud metadata IPs (`169.254.169.254`, `127.0.0.1` host ports).
   - Destructive recursive deletions (`rm -rf /`, `rm -rf /workspace`).

---

## 7. Git Credentials Management & Redaction

### 7.1 Deploy Keys vs. GitHub App Installation Tokens

| Dimension | Deploy Keys (SSH) | GitHub App Installation Tokens |
| :--- | :--- | :--- |
| **Scope** | Single repository only. Zero cross-repository reach. | Scoped strictly to repositories selected during App installation. |
| **Privilege Granularity** | Read-Only or Read-Write on git push/pull. | Fine-grained permissions (Contents: Read/Write, Pull Requests: Write). |
| **Lifetime & Rotation** | Long-lived until revoked; rotated every 90 days. | Short-lived: 1 hour maximum lifetime. Minted dynamically on-demand. |
| **Recommended Use Case** | Dedicated long-running staging devboxes. | Multi-tenant user workspaces and automated agent PR generation. |

### 7.2 Storage, Execution & Streaming Redaction
- **Dedicated Credential Encryption Key:** Credentials are encrypted at rest using AES-256-GCM using a dedicated key (`CREDENTIALS_ENCRYPTION_KEY`), completely segregated from session tokens (`AUTH_SESSION_SECRET`).
- **No Disk Persistence & No SSH Agent Forwarding:** Credentials are never written to `/workspace/.git/config` as plaintext tokens, and SSH agent forwarding is strictly disallowed. Git authentication inside devboxes is handled exclusively via a short-lived credential helper executed by the broker that provides ephemeral tokens on demand.
- **Streaming Output Redaction:** Terminal streams and agent event logs pass through real-time regex redaction buffers that mask GitHub tokens (`ghp_[A-Za-z0-9_]{36}`, `ghs_[A-Za-z0-9_]{36}`), SSH private keys (`-----BEGIN OPENSSH PRIVATE KEY-----`), and provider API keys before transmission to the browser client or event store.

---

## 8. Publishing Adapters & Trust Boundaries

```mermaid
graph TD
    Workspace[Sanitized Workspace Files] --> AdapterRouter{Publish Adapter Router}
    AdapterRouter -->|1. Local Host| CoderxpDeploy[CoderXP Preview Deploy\nPrivate Container Port]
    AdapterRouter -->|2. GitHub| GitHubPush[GitHub Push Adapter\nEphemeral App Token]
    AdapterRouter -->|3. Vercel| VercelDeploy[Vercel API Adapter\nScoped Deploy Token]
    AdapterRouter -->|4. Archive| ZipExport[Sanitized ZIP Export\nStateless Stream]
```

1. **CoderXP Local Deploy:** Deploys application into an isolated preview container within CoderXP hosting perimeter. Authenticated via cryptographically random 128-bit preview slugs. Inaccessible from external networks without session auth.
2. **GitHub Push Adapter:** Pushes commits or creates Pull Requests against upstream repository. Authenticated exclusively via short-lived GitHub App installation tokens. Filters `.env` files, secrets, and transient devbox artifacts.
3. **Vercel API Deploy Adapter:** Deploys web applications via Vercel REST API using user-supplied, scoped deployment tokens held ephemerally in server memory.
4. **Sanitized ZIP Export:** Bundles workspace into a downloadable `.zip` archive for local extraction. Deterministic filtering strips `.git/`, `node_modules/`, `.env*` secret files, and build cache directories statelessly in streaming memory.

---

## 9. Base Images & Build-Time Digest Pinning Policy

CoderXP disallows dynamic `latest` tags. Base images target upstream official distributions, and the repository enforces full cryptographic SHA256 digest pinning as a strict build-time policy: during image builds in CI, the exact immutable image digest is resolved from the upstream registry and recorded directly into the repository configuration. Devbox runtimes execute exclusively against these recorded digests. Node.js images strictly use Node 22 (the project runtime baseline):

* **Node.js Stack (Node >= 22):** `node:22-bookworm-slim`
  - Includes Node.js 22 LTS, pnpm, yarn, npm, Git, curl, jq.
* **Python Stack:** `python:3.11-slim-bookworm`
  - Includes Python 3.11, pip, uv, virtualenv, build-essential.
* **Go Stack:** `golang:1.23-bookworm`
  - Includes Go 1.23, git, gcc, libc6-dev.
* **Rust Stack:** `rust:1.82-slim-bookworm`
  - Includes Rust 1.82, cargo, rustc, mold linker.

Digests are resolved and pinned during the CI image build pipeline and audited weekly with automated CVE scanners (Trivy/Grype). Base images never contain unneeded host-level build utilities or setuid binaries.

---

## 10. Dedicated GPU Infrastructure & Media Service Topology

Media generation capabilities are decoupled from devbox compute and provided by a dedicated GPU cluster via the `IMediaJobService` contract:

* **Host Machine:** the GPU host.
* **Hardware Configuration:** 2x NVIDIA RTX PRO 6000 Blackwell Server Edition (96 GB VRAM each).
  - **GPU 0 (`cuda:0`):** Exclusively dedicated to ComfyUI media generation workflows.
  - **GPU 1 (`cuda:1`):** Reserved for future development workspaces and agent workloads.
* **Software Stack:** ComfyUI 0.36.0 (git commit `ee71d5c`), Python 3.11, PyTorch `2.9.1+cu128`.
* **Network & Security Boundary:**
  - The ComfyUI service has **no outbound internet access** (`no internet egress`).
  - No custom unverified nodes; all pipelines execute purely via native ComfyUI nodes.
  - No runtime model downloads. All model weights are pre-loaded and immutable:
    - `flux1-schnell-fp8.safetensors` via `CheckpointLoaderSimple`
    - `wan2.1_t2v_1.3B_fp16.safetensors` via `UNETLoader`
    - `umt5_xxl_fp8_e4m3fn_scaled.safetensors` via `CLIPLoader` (type: `wan`)
    - `wan_2.1_vae.safetensors` via `VAELoader`
  - **Server-Only Invocation:** Devboxes never communicate with ComfyUI. Only the CoderXP server calls `COMFYUI_URL` (`http://127.0.0.1:8188`) over the secure localhost SSH tunnel through the `IMediaJobService` interface.

---

## 11. Implementation Phasing & Non-Goals

### 11.1 Phasing Roadmap

1. **Phase 1 (Immediate / CoderXP 1.0):**
   - Containerized Docker sandboxes with unprivileged execution (`UID 1000:GID 1000`).
   - Read-only rootfs (`--read-only`) with memory-backed tmpfs (`/tmp`).
   - Resource quotas (CPU, RAM, PID limits).
   - Centralized `AuthzGate` for all agent tool dispatches.
   - Verified teardown sequence and mount leak detection.
   - Server-side localhost tunnel integration with dedicated ComfyUI GPU server.
2. **Phase 2 (CoderXP 1.1):**
   - MicroVM hypervisor evaluation (Firecracker / Cloud-Hypervisor) for multi-tenant isolation.
   - Ephemeral GitHub App installation token integration and isolated credential helper.
   - Vercel and GitHub publish adapters.
   - Fine-grained per-project XFS storage quotas.
3. **Phase 3 (CoderXP 2.0):**
   - Distributed multi-host devbox cluster with Kubernetes/Nomad orchestration.
   - Dynamic GPU allocation for devboxes requiring local CUDA compute using reserved GPU 1.

### 11.2 Explicit Non-Goals

* **Arbitrary Host Root Access:** CoderXP will never provide sudo, root shells, or host namespace access to devbox users or autonomous agents.
* **Docker-in-Docker (DinD):** Running nested unconfined Docker engines inside devboxes is explicitly rejected due to root-equivalence and kernel security risks.
* **Dynamic Model Downloads on GPU Workers:** The GPU cluster will not download models on-the-fly during job requests. All models must be pre-baked into verified storage.
* **Direct Devbox-to-ComfyUI Access:** Devboxes will never connect directly to the ComfyUI tunnel or GPU infrastructure.
* **Unauthenticated Public Preview Tunnels:** Devbox preview URLs will never expose unauthenticated public endpoints without session validation or explicit 128-bit preview slugs.
