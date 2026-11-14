// 同じAPI fixtureと本番ビルドで、変更前後に同じコマンドを実行する。
const fs = require('node:fs');
for (const key of ['PLAYWRIGHT_MODULE', 'CHROMIUM_EXECUTABLE', 'GITDASH_TEST_ORIGIN', 'GITDASH_PROJECT_FIXTURE', 'GITDASH_TEST_OUTPUT']) {
  if (!process.env[key]) throw new Error(`${key} を設定してください`);
}
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);

(async () => {
  const output = process.env.GITDASH_TEST_OUTPUT;
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE, args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
    const fixture = JSON.parse(fs.readFileSync(process.env.GITDASH_PROJECT_FIXTURE));
    await page.route('**/api/project?**', route => route.fulfill({ json: fixture }));
    const params = new URLSearchParams({ path: fixture.main_path, tab: 'info', range: '7d' });
    await page.goto(`${process.env.GITDASH_TEST_ORIGIN}/project?${params}`);
    await page.locator('#project-tab-flow').waitFor();
    await page.waitForTimeout(2000);
    const session = await page.context().newCDPSession(page);
    await session.send('Profiler.enable');
    await session.send('Profiler.start');
    const times = [];
    for (let index = 0; index < 6; index++) {
      await page.locator('#project-tab-info').click();
      await page.locator('#project-tab-flow').waitFor();
      await page.waitForTimeout(250);
      times.push(await page.evaluate(() => new Promise(resolve => {
        const start = performance.now();
        document.querySelector('#project-tab-flow').click();
        const check = () => {
          if (document.querySelector('[data-flow-row]')) {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
          } else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      })));
    }
    const { profile } = await session.send('Profiler.stop');
    fs.writeFileSync(`${output}/branch-tab-cpu.json`, JSON.stringify(profile));
    const result = { times, rows: await page.locator('[data-flow-row]').count() };
    fs.writeFileSync(`${output}/branch-tab-result.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    await page.screenshot({ path: `${output}/branch-tab.png` });
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
