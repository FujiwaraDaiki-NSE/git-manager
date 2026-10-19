// Real browser checks for a disposable repository with conflict.txt, normal.txt and a >200KB staged patch.
const assert=require('node:assert/strict'),fs=require('node:fs/promises');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
(async()=>{
 const fixture=JSON.parse(await fs.readFile(process.env.GITDASH_TEST_FIXTURE,'utf8'));
 const origin=process.env.GITDASH_TEST_ORIGIN,output=process.env.GITDASH_TEST_OUTPUT;assert.ok(origin&&output);await fs.mkdir(output,{recursive:true});
 const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
 try{
  await page.goto(`${origin}/project?path=${encodeURIComponent(fixture.path)}&tab=lanes&range=current`);
  const row=page.locator('#project-lane-results tr').filter({has:page.locator('.lane-name-button strong').filter({hasText:/^main$/})});await row.getByRole('button',{name:'Git詳細',exact:true}).click();
  assert.ok((await page.locator('.status-file-row').filter({hasText:'conflict.txt'}).innerText()).includes('差分対象外'));
  const diff=page.locator('.worktree-diff'),stage=page.getByRole('group',{name:'差分の段階'});await diff.locator('.worktree-diff-snapshot').waitFor();
  assert.ok((await diff.locator('.worktree-diff-exclusion').innerText()).includes('競合 1 件'));
  let pending=page.waitForEvent('download');await diff.getByRole('button',{name:'生パッチを保存',exact:true}).click();let download=await pending;let patch=await fs.readFile(await download.path(),'utf8');assert.ok(patch.includes('+normal working')&&!patch.includes('diff --cc')&&!patch.includes('<<<<<<<'));
  await stage.getByRole('button',{name:'ステージ済み',exact:true}).click();await diff.getByRole('button',{name:'部分パッチを保存',exact:true}).waitFor();assert.ok((await diff.locator('.worktree-diff-exclusion').innerText()).includes('競合 1 件'));
  pending=page.waitForEvent('download');await diff.getByRole('button',{name:'部分パッチを保存',exact:true}).click();download=await pending;assert.ok(download.suggestedFilename().includes('partial'));const bytes=await fs.readFile(await download.path());assert.ok(bytes.length<=200000&&bytes.length>190000);patch=bytes.toString();assert.ok(patch.includes('large.txt')&&!patch.includes('diff --cc'));
  await diff.locator('.worktree-diff-truncated').scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/conflict-partial.png`});await page.setViewportSize({width:390,height:844});await diff.locator('.worktree-diff-heading').scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/conflict-partial-mobile.png`});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  const result={origin,fixture:fixture.path,passed:['Conflict paths explicitly excluded while ordinary unstaged changes remain available','Staged metadata and bounded patch remain available with conflicts','Partial patch warning, partial filename and <=200000-byte download','390px mobile layout without page overflow'],errors};await fs.writeFile(`${output}/edge-result.json`,JSON.stringify(result,null,2));console.log(result);
 }catch(e){await page.screenshot({path:`${output}/edge-failure.png`});console.error((await page.locator('body').innerText()).slice(-3500));throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
