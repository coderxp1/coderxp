import subprocess
import os

key_src = "C:/Users/hartm/strato-private-744"
tmp_key = "C:/Users/hartm/.ssh/temp_old_key"

try:
    with open(key_src, "rb") as f:
        data = f.read()
    with open(tmp_key, "wb") as f:
        f.write(data)
    os.chmod(tmp_key, 0o600)

    subprocess.run(["ssh-keygen", "-p", "-f", tmp_key, "-N", "", "-P", "Ecuagrowers10@@"], capture_output=True)

    cmd = 'cat /root/.ssh/authorized_keys; ls -la /root/.ssh'
    res = subprocess.run(["ssh", "-o", "StrictHostKeyChecking=no", "-i", tmp_key, "root@31.70.107.44", cmd], capture_output=True, text=True)
    print("REMOTE .ssh INFO:")
    print("STDOUT:", res.stdout)
    print("STDERR:", res.stderr)
finally:
    if os.path.exists(tmp_key):
        os.remove(tmp_key)
