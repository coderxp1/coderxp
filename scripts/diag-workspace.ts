import { chromium } from "playwright";
import * as fs from "node:fs";

async function diag() {
  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const browserPath = fs.existsSync(edgePath) ? edgePath : chromePath;

  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://localhost:3055/workspace", { waitUntil: "networkidle" });
  await page.screenshot({ path: "screenshots/diag_workspace.png" });
  const html = await page.content();
  console.log("HTML snippet:", html.slice(0, 1000));
  await browser.close();
}

diag().catch(console.error);
