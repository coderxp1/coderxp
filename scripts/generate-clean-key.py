import subprocess
import os

key_path = "C:/Users/hartm/.ssh/coderxp_deploy"
if os.path.exists(key_path):
    os.remove(key_path)
if os.path.exists(key_path + ".pub"):
    os.remove(key_path + ".pub")

# Generate with git bash ssh-keygen
git_ssh_keygen = "C:/Program Files/Git/usr/bin/ssh-keygen.exe"
subprocess.run([git_ssh_keygen, "-t", "ed25519", "-f", key_path, "-C", "coderxp-deploy-2026", "-N", ""], check=True)

with open(key_path + ".pub", "r") as f:
    pub_content = f.read().strip()

print("NEW_PUB_KEY:", pub_content)

# Now append to server authorized_keys
key_src = "C:/Users/hartm/strato-private-744"
tmp_key = "C:/Users/hartm/.ssh/temp_old_key"

try:
    with open(key_src, "rb") as f:
        data = f.read()
    with open(tmp_key, "wb") as f:
        f.write(data)
    os.chmod(tmp_key, 0o600)
    subprocess.run([git_ssh_keygen, "-p", "-f", tmp_key, "-N", "", "-P", "Ecuagrowers10@@"], capture_output=True)

    git_ssh = "C:/Program Files/Git/usr/bin/ssh.exe"
    # Overwrite authorized_keys with BOTH old key and new key
    cmd = f'echo "{pub_content}" >> /root/.ssh/authorized_keys && cat /root/.ssh/authorized_keys'
    res = subprocess.run([git_ssh, "-o", "StrictHostKeyChecking=no", "-i", tmp_key, "root@31.70.107.44", cmd], capture_output=True, text=True)
    print("APPEND RESULT:")
    print(res.stdout)
    print(res.stderr)
finally:
    if os.path.exists(tmp_key):
        os.remove(tmp_key)

# Now test login with new key
git_ssh = "C:/Program Files/Git/usr/bin/ssh.exe"
test_res = subprocess.run([git_ssh, "-v", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "IdentitiesOnly=yes", "-i", key_path, "root@31.70.107.44", "echo SUCCESS_FROM_NEW_KEY"], capture_output=True, text=True)
print("TEST NEW KEY LOGIN:")
print("STDOUT:", test_res.stdout)
print("STDERR:", test_res.stderr)
