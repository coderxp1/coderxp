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

    # Decrypt temporary old key
    subprocess.run(["ssh-keygen", "-p", "-f", tmp_key, "-N", "", "-P", "Ecuagrowers10@@"], capture_output=True)

    new_pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHgxg1ebSqTtfA3Br1717pPQRHMW3PdQrU6u8IkzCvlr coderxp-deploy-2026\n"

    # Step 3: Append new key to authorized_keys
    cmd = f'echo "{new_pub.strip()}" >> /root/.ssh/authorized_keys && cat /root/.ssh/authorized_keys'
    res = subprocess.run(["ssh", "-o", "StrictHostKeyChecking=no", "-i", tmp_key, "root@31.70.107.44", cmd], capture_output=True, text=True)
    print("AUTHORIZED KEYS AFTER APPEND:")
    print(res.stdout)
    print(res.stderr)
finally:
    if os.path.exists(tmp_key):
        os.remove(tmp_key)
