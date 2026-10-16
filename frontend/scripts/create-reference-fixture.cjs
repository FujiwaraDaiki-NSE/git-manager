// Creates a disposable repository with annotated/lightweight tags and HEAD reflog.
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const root=process.argv[2];if(!root||!path.isAbsolute(root))throw new Error('An explicit absolute parent directory is required');
const fixture=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'create-investigation-fixture.cjs'),root],{encoding:'utf8'}));
const git=(...args)=>execFileSync('git',['-C',fixture.path,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git('tag','v1.0',fixture.base);
git('tag','-a','v2.0','-m','Release two\n\nRelease notes: feature added.',fixture.target);
git('tag','-a','nightly','-m','Nightly annotated build',fixture.main);
console.log(JSON.stringify({...fixture,tags:['v1.0','v2.0','nightly']},null,2));
