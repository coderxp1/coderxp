import subprocess
import os

new_key = "C:/Users/hartm/.ssh/coderxp_deploy"
git_ssh = "C:/Program Files/Git/usr/bin/ssh.exe"

new_pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHd56TuCioC4OipnHjuHDqLXcP34UUzkKnMF34f74PRc coderxp-deploy-2026\n"

# 1. Update /root/.ssh/authorized_keys to ONLY have the new key
update_cmd = f'echo "{new_pub.strip()}" > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && cat /root/.ssh/authorized_keys && ssh-keygen -lf /root/.ssh/authorized_keys'
res1 = subprocess.run([git_ssh, "-o", "StrictHostKeyChecking=no", "-i", new_key, "root@31.70.107.44", update_cmd], capture_output=True, text=True)
print("=== 1. AUTHORIZED_KEYS (NEW ONLY) ===")
print("STDOUT:", res1.stdout)
print("STDERR:", res1.stderr)

# 2. Test logging in with OLD KEY - MUST FAIL
old_key_src = "C:/Users/hartm/strato-private-744"
tmp_old = "C:/Users/hartm/.ssh/temp_old_test"
with open(old_key_src, "rb") as f:
    old_data = f.read()
with open(tmp_old, "wb") as f:
    f.write(old_data)
os.chmod(tmp_old, 0o600)
subprocess.run(["C:/Program Files/Git/usr/bin/ssh-keygen.exe", "-p", "-f", tmp_old, "-N", "", "-P", "Ecuagrowers10@@"], capture_output=True)

old_login_res = subprocess.run([git_ssh, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-i", tmp_old, "root@31.70.107.44", "echo OLD_KEY_LOGGED_IN"], capture_output=True, text=True)
print("=== 2. OLD KEY LOGIN ATTEMPT (EXPECTED TO FAIL) ===")
print("Return Code:", old_login_res.returncode)
print("STDOUT:", old_login_res.stdout)
print("STDERR:", old_login_res.stderr)
if os.path.exists(tmp_old):
    os.remove(tmp_old)

# 3. Check logs: last -20 and auth log
log_cmd = 'last -20; grep -iE "accepted|failed" /var/log/auth.log 2>/dev/null | tail -n 30 || journalctl -u ssh -n 30'
res_logs = subprocess.run([git_ssh, "-o", "StrictHostKeyChecking=no", "-i", new_key, "root@31.70.107.44", log_cmd], capture_output=True, text=True)
print("=== 3. LOGIN HISTORY & AUTH LOGS ===")
print(res_logs.stdout)

# 4. Check / Harden sshd_config and fail2ban
harden_cmd = 'apt-get update -qq && apt-get install -y -qq fail2ban && systemctl enable fail2ban && systemctl start fail2ban && grep -i "PasswordAuthentication" /etc/ssh/sshd_config /etc/ssh/sshd_config.d/* 2>/dev/null || true'
res_harden = subprocess.run([git_ssh, "-o", "StrictHostKeyChecking=no", "-i", new_key, "root@31.70.107.44", harden_cmd], capture_output=True, text=True)
print("=== 4. HARDENING (FAIL2BAN & PASSWORDAUTH) ===")
print(res_harden.stdout)
