import { chromium } from playwright;
import * as fs from fs;
import * as path from path;

async function runRecording() {
  console.log(=== STARTING ONE-TAKE PRODUCTION SCREEN RECORDING ===);
  const recordingsDir = path.join(process.cwd(), recordings);
  const screenshotsDir = path.join(process.cwd(), screenshots);

  const browser = await chromium.launch({
    channel: msedge,
    headless: false,
    args: [--window-size=1440,900],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: {
      dir: recordingsDir,
      size: { width: 1440, height: 900 },
    },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  console.log(Navigating to https://coderxp.pro/workspace...);
  await page.goto(https://coderxp.pro/workspace, { waitUntil: networkidle });
  await page.waitForTimeout(2000);

  // Check for login redirect
  if (page.url().includes(/login)) {
    console.log(Authenticating at login page...);
    await page.fill('input[name=identifier], input[type=text], input[type=email]', coderxpadmin);
    await page.fill('input[type=password]', coderxp-pilot-2026);
    await page.click('button[type=submit]');
    await page.waitForURL(**/workspace, { timeout: 15000 });
    await page.waitForTimeout(3000);
  }

  // Verify Cascadia Mono font
  const fontLoaded = await page.evaluate(() => document.fonts.check('14px Cascadia Mono'));
  console.log(Font Cascadia Mono loaded:, fontLoaded);

  // Wait for terminal prompt
  console.log(Waiting for terminal prompt developer@coderxp-devbox:/workspace$ ...);
  await page.waitForTimeout(4000);

  // Take Screenshot 1: Clean non-root terminal
  await page.screenshot({ path: path.join(screenshotsDir, 01_terminal_clean_non_root.png) });
  console.log(Screenshot 1 captured: Clean terminal with Cascadia Mono and non-root prompt.);

  // Type ls -la into the terminal
  console.log(Sending ls -la to terminal...);
  await page.keyboard.type(ls -la);
  await page.keyboard.press(Enter);
  await page.waitForTimeout(2000);

  // Take Screenshot 2: Aligned ls -la output
  await page.screenshot({ path: path.join(screenshotsDir, 02_terminal_ls_aligned.png) });
  console.log(Screenshot 2 captured: Terminal ls -la aligned.);

  // Step 3: Chat build me a dark theme landing page
  console.log(Submitting prompt: 'build me a dark theme landing page'...);
  const composer = page.locator(#composerInput);
  await composer.waitFor({ state: visible, timeout: 10000 });
  await composer.fill(build me a dark theme landing page);
  await page.click(#sendBtn);

  console.log(Waiting for agent to create files...);
  await page.waitForTimeout(8000);

  // Verify files in tree / editor
  await page.screenshot({ path: path.join(screenshotsDir, 03_agent_files_created.png) });
  console.log(Screenshot 3 captured: Files created in workspace.);

  // Step 4: Chat run it
  console.log(Submitting prompt: 'run it'...);
  await composer.fill(run it);
  await page.click(#sendBtn);

  console.log(Waiting for server to start and port to be reported...);
  await page.waitForTimeout(6000);

  await page.screenshot({ path: path.join(screenshotsDir, 04_server_running_port_3000.png) });
  console.log(Screenshot 4 captured: Server running on port 3000.);

  // Step 5: Click Top Bar Live Preview Button
  console.log(Clicking top bar Live Preview button...);
  const livePreviewBtn = page.locator(.live-preview-btn);
  await livePreviewBtn.waitFor({ state: visible, timeout: 5000 });

  const [popup] = await Promise.all([
    context.waitForEvent(page, { timeout: 10000 }).catch(() => null),
    livePreviewBtn.click(),
  ]);

  await page.waitForTimeout(3000);

  if (popup) {
    console.log(Live Preview popup opened:, popup.url());
    await popup.waitForLoadState(networkidle).catch(() => {});
    await popup.screenshot({ path: path.join(screenshotsDir, 05_live_preview_window.png) });
  }

  await page.screenshot({ path: path.join(screenshotsDir, 06_full_workspace_success.png) });
  console.log(Final screenshot captured.);

  // Close context to finalize video
  console.log(Closing browser and finalizing screen recording...);
  await page.close();
  await context.close();
  await browser.close();

  // Find video file
  const videoFiles = fs.readdirSync(recordingsDir).filter((f) => f.endsWith(.webm));
  if (videoFiles.length > 0) {
    const latestVideo = path.join(recordingsDir, videoFiles[videoFiles.length - 1]);
    const artifactDir = C:\\Users\\hartm\\.gemini\\antigravity\\brain\\e616387d-a088-467c-ab6c-ac0e1f983b96;
    const dest = path.join(artifactDir, coderxp_one_take_production_recording.webm);
    fs.copyFileSync(latestVideo, dest);
    console.log(=== SCREEN RECORDING SAVED SUCCESSFULLY ===);
    console.log(Destination:, dest);
    console.log(Size:, fs.statSync(dest).size, bytes);
  } else {
    console.warn(No video file generated in recordings dir.);
  }
}

runRecording().catch((err) => {
  console.error(Recording error:, err);
  process.exit(1);
});
