import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const artifactDir = "C:\\Users\\hartm\\.gemini\\antigravity\\brain\\cc529555-28ef-4044-be09-bf93f8941c35\\screenshots";
if (!fs.existsSync(artifactDir)) {
  fs.mkdirSync(artifactDir, { recursive: true });
}

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9333;
const TMP_PROFILE = "C:\\Users\\hartm\\AppData\\Local\\Temp\\chrome_cdp_profile";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

function httpPutJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "PUT" }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.callbacks = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      this.ws.onmessage = (msg) => {
        const res = JSON.parse(msg.data);
        if (res.id && this.callbacks.has(res.id)) {
          const cb = this.callbacks.get(res.id);
          this.callbacks.delete(res.id);
          if (res.error) cb.reject(res.error);
          else cb.resolve(res.result);
        }
      };
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function capture(url, width, height, outFileName) {
  console.log(`Navigating to ${url} at ${width}x${height}...`);
  const target = await httpPutJson(`http://localhost:${PORT}/json/new?${encodeURIComponent(url)}`);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();

  await client.send("Page.enable");
  await client.send("DOM.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });

  await client.send("Page.navigate", { url });
  await sleep(3500); // Wait for React hydration & rendering

  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });

  const outPath = path.join(artifactDir, outFileName);
  fs.writeFileSync(outPath, Buffer.from(data, "base64"));
  console.log(`Saved screenshot: ${outPath} (${(data.length * 0.75 / 1024).toFixed(1)} KB)`);

  client.close();
  await httpGetJson(`http://localhost:${PORT}/json/close/${target.id}`).catch(() => {});
}

async function main() {
  console.log("Starting headless Chrome with remote debugging on port " + PORT);
  const chromeProcess = spawn(CHROME_PATH, [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${TMP_PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
  ]);

  await sleep(4000);

  try {
    const protoUrl = "file:///C:/Users/hartm/Downloads/coderxp-workspace-v2.html";
    const appUrl = "http://localhost:3000/workspace";

    // 1440px Desktop
    await capture(protoUrl, 1440, 900, "proto_1440.png");
    await capture(appUrl, 1440, 900, "app_1440.png");

    // 1024px Compact
    await capture(protoUrl, 1024, 768, "proto_1024.png");
    await capture(appUrl, 1024, 768, "app_1024.png");

    // 390px Mobile
    await capture(protoUrl, 390, 844, "proto_mobile.png");
    await capture(appUrl, 390, 844, "app_mobile.png");

    console.log("ALL SCREENSHOTS CAPTURED SUCCESSFULLY!");
  } finally {
    chromeProcess.kill();
  }
}

main().catch((err) => {
  console.error("Error capturing screenshots:", err);
  process.exit(1);
});
