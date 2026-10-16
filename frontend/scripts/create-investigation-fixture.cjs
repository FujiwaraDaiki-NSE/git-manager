// Creates an isolated disposable repository; never changes an existing checkout.
// node create-investigation-fixture.cjs /absolute/scan/root > /tmp/fixture.json
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=process.argv[2];if(!root||!path.isAbsolute(root))throw new Error('An explicit absolute parent directory is required');
const repo=fs.mkdtempSync(path.join(root,'gitdash-ui-investigation-'));
const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git('init','-b','main');git('config','user.name','UI Fixture');git('config','user.email','fixture@example.invalid');git('config','core.hooksPath','/dev/null');
fs.writeFileSync(path.join(repo,'old name.txt'),'first\nsecond\n');git('add','.');git('commit','-m','Create original file');const base=git('rev-parse','HEAD');
git('switch','-c','feature');git('mv','old name.txt','renamed.txt');git('commit','-m','Rename document');fs.appendFileSync(path.join(repo,'renamed.txt'),'feature\n');git('commit','-am','Extend document');const target=git('rev-parse','HEAD');
git('switch','main');fs.writeFileSync(path.join(repo,'main.txt'),'main only\n');git('add','.');git('commit','-m','Update main separately');const main=git('rev-parse','HEAD');
fs.appendFileSync(path.join(repo,'old name.txt'),'stashed tracked\n');fs.writeFileSync(path.join(repo,'untracked [file].txt'),'untracked stash data\n');git('stash','push','-u','-m','UI fixture stash');
console.log(JSON.stringify({path:repo,base,target,main,stash:git('rev-parse','refs/stash')},null,2));
