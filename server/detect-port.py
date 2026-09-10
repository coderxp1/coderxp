#!/usr/bin/env python3
"""
Dynamic Port Detector for CoderXP Devbox.
Detects the TCP listening port bound by a background process tree (Next.js, Vite, etc.)
using /proc/net/tcp and /proc/<pid>/fd socket correlation.
"""

import sys
import os
import re

def get_process_tree_pids(root_pid):
    pids = {root_pid}
    try:
        entries = [e for e in os.listdir("/proc") if e.isdigit()]
        for entry in entries:
            pid = int(entry)
            try:
                with open(f"/proc/{pid}/stat", "r") as f:
                    stat_content = f.read()
                # ppid is after the command name in parentheses
                ppid = int(stat_content.split(") ")[1].split()[1])
                if ppid in pids:
                    pids.add(pid)
            except Exception:
                continue
    except Exception:
        pass
    return pids

def get_socket_inodes_for_pids(pids):
    inodes = set()
    for pid in pids:
        fd_dir = f"/proc/{pid}/fd"
        if not os.path.exists(fd_dir):
            continue
        try:
            for fd in os.listdir(fd_dir):
                try:
                    target = os.readlink(f"{fd_dir}/{fd}")
                    match = re.match(r"^socket:\[(\d+)\]$", target)
                    if match:
                        inodes.add(match.group(1))
                except Exception:
                    continue
        except Exception:
            continue
    return inodes

def detect_port(target_pid=None):
    tree_inodes = set()
    if target_pid and target_pid > 0:
        tree_pids = get_process_tree_pids(target_pid)
        tree_inodes = get_socket_inodes_for_pids(tree_pids)

    tree_matched_ports = []
    all_listening_ports = []

    for path in ["/proc/net/tcp", "/proc/net/tcp6"]:
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r") as f:
                lines = f.readlines()[1:]
            for line in lines:
                parts = line.strip().split()
                if len(parts) >= 10 and parts[3] == "0A":  # TCP_LISTEN
                    hex_port = parts[1].split(":")[1]
                    port = int(hex_port, 16)
                    inode = parts[9]
                    if inode in tree_inodes:
                        tree_matched_ports.append(port)
                    if port not in (22, 80, 443):
                        all_listening_ports.append(port)
        except Exception:
            continue

    if tree_matched_ports:
        return tree_matched_ports[0]
    if all_listening_ports:
        return all_listening_ports[0]
    return None

if __name__ == "__main__":
    target_pid = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else None
    port = detect_port(target_pid)
    if port:
        print(port)
        sys.exit(0)
    else:
        sys.exit(1)
