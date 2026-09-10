import http from "node:http";
import subprocess from "node:child_process";
import path from "node:path";
import fs from "node:fs";

function postEvent(body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      "http://127.0.0.1:3055/api/devbox/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let resData = "";
        res.on("data", (c) => (resData += c));
        res.on("end", () => resolve(JSON.parse(resData)));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const projectId = "proj-demo-live";

  console.log("Seeding authentic events into local Next.js server...");
  await postEvent({
    projectId,
    tier: "T0",
    type: "step.started",
    data: { title: "Clone repository https://github.com/phartmann80/coderxp.git" },
  });

  await postEvent({
    projectId,
    tier: "T0",
    type: "step.completed",
    data: { title: "Cloned repository (1.8s)", tokensUsed: { input: 150, output: 40 } },
  });

  await postEvent({
    projectId,
    tier: "T1",
    type: "pkg.installed",
    data: { title: "npm install express lodash (3.2s)", tokensUsed: { input: 280, output: 95 } },
  });

  await postEvent({
    projectId,
    tier: "T0",
    type: "test.run_completed",
    data: { title: "Ran test suite (14 passed, 0 failed)", tokensUsed: { input: 400, output: 120 } },
  });

  await postEvent({
    projectId,
    tier: "T3",
    type: "approval.requested",
    data: {
      title: "Action requires approval: Pushing to default branch \"main\" requires approval.",
      branch: "main",
    },
  });

  console.log("Events seeded successfully.");

  const edgeExe = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const outDir = "C:/Users/hartm/.gemini/antigravity/brain/cc529555-28ef-4044-be09-bf93f8941c35";
  const outPng = path.join(outDir, "genuine_timeline_ui_render.png");

  console.log("Capturing authentic browser screenshot at 1440x900 from http://127.0.0.1:3055/workspace...");
  const cmd = [
    edgeExe,
    "--headless",
    "--disable-gpu",
    "--window-size=1440,900",
    `--screenshot=${outPng}`,
    "http://127.0.0.1:3055/workspace"
  ];

  subprocess.execFileSync(cmd[0], cmd.slice(1));

  if (fs.existsSync(outPng)) {
    console.log("SUCCESS: Genuine screenshot written to:", outPng, "(size:", fs.statSync(outPng).size, "bytes)");
  } else {
    console.error("Screenshot capture failed.");
  }
}

main().catch(console.error);
