import subprocess
import os
import time

edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
chrome_path = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

browser_exe = edge_path if os.path.exists(edge_path) else chrome_path

out_dir = r"C:\Users\hartm\.gemini\antigravity\brain\cc529555-28ef-4044-be09-bf93f8941c35\screenshots"
os.makedirs(out_dir, exist_ok=True)
out_png = os.path.join(out_dir, "real_production_timeline_workspace.png")

target_url = "https://coderxp.pro/workspace"

# We use headless browser with screenshot argument
cmd = [
    browser_exe,
    "--headless",
    "--disable-gpu",
    "--window-size=1440,900",
    "--hide-scrollbars",
    f"--screenshot={out_png}",
    target_url
]

print("Launching headless browser to capture genuine screenshot:")
print("Browser:", browser_exe)
print("Target:", target_url)
print("Output:", out_png)

res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
print("Return code:", res.returncode)
print("Stdout:", res.stdout)
print("Stderr:", res.stderr)

if os.path.exists(out_png):
    print("SUCCESS: Genuine screenshot created with size:", os.path.getsize(out_png), "bytes")
else:
    print("Failed to produce screenshot file")
