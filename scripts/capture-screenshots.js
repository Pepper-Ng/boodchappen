const { chromium } = require('playwright');
const path = require('path');

const BASE_URL = 'http://boodschappen-test.stefhermans.nl';
const OUTPUT_DIR = 'C:/Users/Stef/Documents/Projects/boodchappen/frontend/public/tutorial';

const CHAPTERS = ['account', 'recipes', 'products', 'week', 'shopping', 'jobs'];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ 
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();

  // Set theme and language
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    localStorage.setItem('boodschappen.theme', 'light');
    localStorage.setItem('boodschappen.language', 'en');
  });

  // Try to register (ignore if already exists)
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  try {
    const registerTab = page.locator('button').filter({ hasText: /^Register$/ }).first();
    if (await registerTab.isVisible()) await registerTab.click();
    const emailField = page.locator('input[type=email]').first();
    await emailField.fill('screenshot@test.local');
    const passField = page.locator('input[type=password]').first();
    await passField.fill('Screenshot2026!');
    await page.locator('button[type=submit]').last().click();
    await page.waitForTimeout(2000);
  } catch(e) { console.log('Register skip:', e.message); }

  // Open tutorial
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const tutorialBtn = page.locator('button').filter({ hasText: 'Tutorial' }).first();
  await tutorialBtn.waitFor({ state: 'visible', timeout: 10000 });
  await tutorialBtn.click();
  await page.waitForTimeout(2000);

  // Screenshot each chapter
  for (const chapterId of CHAPTERS) {
    try {
      const chapterBtn = page.locator('.chapter-button').filter({ hasText: chapterId }).first();
      const allButtons = await page.locator('.chapter-button').all();
      console.log('Chapter buttons count:', allButtons.length);
      if (allButtons.length > 0) {
        const btnIndex = CHAPTERS.indexOf(chapterId);
        if (btnIndex < allButtons.length) {
          await allButtons[btnIndex].click();
          await page.waitForTimeout(1000);
        }
      }
      const panel = page.locator('.chapter-panel').first();
      await panel.waitFor({ state: 'visible', timeout: 5000 });
      const outputPath = OUTPUT_DIR + '/' + chapterId + '.png';
      await panel.screenshot({ path: outputPath, scale: 'device' });
      console.log('Captured: ' + outputPath);
    } catch(e) {
      console.error('Error capturing ' + chapterId + ': ' + e.message);
    }
  }

  await browser.close();
  console.log('Done!');
}

main().catch(console.error);
