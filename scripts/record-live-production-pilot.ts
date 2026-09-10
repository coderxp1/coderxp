import { chromium } from "playwright";
import * as path from "node:path";
import * as fs from "node:fs";

async function main() {
  console.log("==========================================================================");
  console.log("     STARTING LIVE PRODUCTION WORKSPACE CONTINUOUS VIDEO RECORDING       ");
  console.log("==========================================================================\n");

  const videoDir = path.resolve("C:/Users/hartm/.gemini/antigravity/brain/cc529555-28ef-4044-be09-bf93f8941c35/videos");
  if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
  }

  const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const browserPath = fs.existsSync(edgePath) ? edgePath : chromePath;

  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const basicUser = process.env.BASIC_AUTH_USER || "coderxpadmin";
  const basicPass = process.env.BASIC_AUTH_PASS || "";

  const contextOptions: any = {
    viewport: { width: 1440, height: 900 },
    recordVideo: {
      dir: videoDir,
      size: { width: 1440, height: 900 },
    },
  };
  if (basicPass) {
    contextOptions.httpCredentials = {
      username: basicUser,
      password: basicPass,
    };
  }

  const context = await browser.newContext(contextOptions);

  const page = await context.newPage();

  try {
    console.log("1. Navigating to https://coderxp.pro/workspace with HTTP Basic Auth...");
    await page.goto("https://coderxp.pro/workspace", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    // If on Project Launcher, create pilot project
    const nameInput = page.locator("input[type='text']").first();
    if (await nameInput.isVisible().catch(() => false)) {
      console.log("Filling project name 'Production Pilot' on launcher...");
      await nameInput.fill("Production Pilot");
      await page.waitForTimeout(1000);
      const createBtn = page.locator("button[type='submit'], button:has-text('Create project')").first();
      await createBtn.click();
      console.log("Created project, waiting for workspace shell to mount...");
      await page.waitForTimeout(5000);
    }

    // Step 1: Send "hi" in Agent Chat
    console.log("2. Sending 'hi' in Agent Chat...");
    const composer = page.locator("#composerInput");
    await composer.waitFor({ state: "visible", timeout: 20000 });
    await composer.click();
    await composer.fill("hi");
    await page.waitForTimeout(1000);
    await composer.press("Enter");

    console.log("3. Waiting for streamed reply from Logicc azure/gpt-4o...");
    await page.waitForTimeout(8000);

    // Step 2: Open Terminal Panel
    console.log("4. Switching to Terminal tab...");
    const termTab = page.locator("button[role='tab']:has-text('TERMINAL')").first();
    if (await termTab.isVisible()) {
      await termTab.click();
    }
    await page.waitForTimeout(3000);

    // Step 3: Type commands in Devbox terminal
    console.log("5. Clicking terminal and typing 'ls -la'...");
    const termCanvas = page.locator(".xterm-screen, .xterm").first();
    if (await termCanvas.isVisible()) {
      await termCanvas.click();
    }
    await page.keyboard.type("ls -la", { delay: 100 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);

    console.log("6. Typing 'git config -l' in terminal...");
    await page.keyboard.type("git config -l", { delay: 100 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);

    // Step 4: Run git push origin main to trigger approval gate
    console.log("7. Triggering 'git push origin main' in terminal...");
    await page.keyboard.type("git push origin main", { delay: 100 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);

    // Step 5: Switch to Activity Timeline to view T3 approval card
    console.log("8. Opening Activity Timeline...");
    const timelineTab = page.locator("button[role='tab']:has-text('TIMELINE')").first();
    if (await timelineTab.isVisible()) {
      await timelineTab.click();
    } else {
      const timelineRail = page.locator("#railTimeline, button[title*='Timeline'], [data-rail='timeline']").first();
      if (await timelineRail.isVisible()) {
        await timelineRail.click();
      }
    }
    await page.waitForTimeout(4000);

    // Step 6: Click Reject on the Approval Card
    console.log("9. Testing Reject on T3 Approval Card...");
    const rejectBtn = page.locator("button:has-text('Reject')").first();
    if (await rejectBtn.isVisible()) {
      await rejectBtn.click();
      console.log("Clicked Reject.");
    }
    await page.waitForTimeout(4000);

    // Step 7: Open GitHub commit history tab
    console.log("10. Navigating to GitHub repo to verify commit was NOT pushed...");
    await page.goto("https://github.com/phartmann80/coderxp/commits/main", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(5000);

    // Step 8: Return to workspace for Approve Once
    console.log("11. Returning to workspace...");
    await page.goto("https://coderxp.pro/workspace", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(4000);

    const termTab2 = page.locator("button[role='tab']:has-text('TERMINAL')").first();
    if (await termTab2.isVisible()) {
      await termTab2.click();
      await page.waitForTimeout(2000);
    }
    console.log("12. Triggering second 'git push origin main'...");
    await page.keyboard.type("git push origin main", { delay: 100 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);

    console.log("13. Opening Activity Timeline for Approval...");
    const timelineTab2 = page.locator("button[role='tab']:has-text('TIMELINE')").first();
    if (await timelineTab2.isVisible()) {
      await timelineTab2.click();
    }
    await page.waitForTimeout(3000);

    const approveBtn = page.locator("button:has-text('Approve Once'), button:has-text('Approve')").first();
    if (await approveBtn.isVisible()) {
      await approveBtn.click();
      console.log("Clicked Approve.");
    }
    await page.waitForTimeout(5000);

    // Step 9: Show GitHub repository with commit
    console.log("14. Navigating to GitHub repo to verify commit arrives on main...");
    await page.goto("https://github.com/phartmann80/coderxp/commits/main", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(5000);

    console.log("15. Continuous recording completed successfully!");
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  // Find saved video
  const files = fs.readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
  if (files.length > 0) {
    const latest = path.join(videoDir, files[files.length - 1]);
    const finalDest = path.resolve("C:/Users/hartm/.gemini/antigravity/brain/cc529555-28ef-4044-be09-bf93f8941c35/pilot_verification_live_production.webm");
    fs.copyFileSync(latest, finalDest);
    console.log(`\n==========================================================================`);
    console.log(`[SUCCESS] Continuous screen recording saved to:`);
    console.log(`${finalDest}`);
    console.log(`==========================================================================`);
  }
}

main().catch((err) => {
  console.error("Recording error:", err);
  process.exit(1);
});
