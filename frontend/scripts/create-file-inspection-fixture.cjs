// Disposable fixture with immutable file versions, blame attribution and both index/worktree changes.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=process.argv[2];if(!root||!path.isAbsolute(root))throw new Error('An explicit absolute parent directory is required');
const fixture=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'create-investigation-fixture.cjs'),root],{encoding:'utf8'}));
const git=(...args)=>execFileSync('git',['-C',fixture.path,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const file=relative=>path.join(fixture.path,relative);
fs.mkdirSync(file('src'));fs.writeFileSync(file('src/example.ts'),'one\ntwo\nthree\n');fs.writeFileSync(file('space.ts'),'export const x=1;\n');fs.writeFileSync(file('binary.dat'),Buffer.from([0,1,2,255]));git('add','.');git('commit','-m','Add source files for inspection');fixture.inspection_main=git('rev-parse','HEAD');
git('switch','feature');fs.mkdirSync(file('src'),{recursive:true});fs.writeFileSync(file('src/example.ts'),'one\ntwo\nthree\n');git('add','.');git('commit','-m','Create source on feature');fs.writeFileSync(file('src/example.ts'),'one\nsecond author line\nthree\n');git('-c','user.name=Second Author','-c','user.email=second@example.invalid','commit','-am','Change one source line');fixture.inspection_feature=git('rev-parse','HEAD');
git('switch','main');fs.writeFileSync(file('src/example.ts'),'one\nstaged line\nthree\n');git('add','src/example.ts');fs.writeFileSync(file('src/example.ts'),'one\nstaged line\nworking line\n');fs.writeFileSync(file('space.ts'),'export const x = 1;\n');git('mv','old name.txt','renamed-working.txt');
console.log(JSON.stringify({...fixture,file:'src/example.ts'},null,2));
