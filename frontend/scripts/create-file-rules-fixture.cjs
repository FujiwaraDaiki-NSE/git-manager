// Create a disposable real Git repository; print its exact path and immutable revision.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=process.argv[2];if(!root||!path.isAbsolute(root))throw new Error('Explicit absolute parent directory required');
const repo=fs.mkdtempSync(path.join(root,'gitdash-file-rules-'));
const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const put=(name,content)=>{const target=path.join(repo,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);};
git('init','-b','main');git('config','user.name','File Rules Fixture');git('config','user.email','file-rules@example.invalid');git('config','core.hooksPath','/dev/null');git('config','core.autocrlf','false');
put('.gitignore','cache/\n*.log\n!keep.log\n');put('.gitattributes','*.txt text eol=lf\n*.dat -text\nsrc/alpha.txt diff=custom\n');put('src/alpha.txt','Needle first\nneedle lower\nNeedle last\n');put('docs/beta.md','Needle documentation\n');put('plain.txt','plain\n');put('mixed.dat',Buffer.from('first\r\nsecond\n'));put('src/binary.dat',Buffer.from([0,78,101,101,100,108,101,255]));put('tracked.log','tracked log\n');put('src/.gitignore','secret*.tmp\n');git('add','.');git('add','-f','tracked.log');git('commit','-m','Seed file search and rule investigations');const revision=git('rev-parse','HEAD');
put('.gitattributes','*.txt text eol=crlf\n*.dat -text\nsrc/alpha.txt diff=custom\n');put('cache/generated.txt','ignored cache\n');put('debug.log','ignored log\n');put('keep.log','negated rule\n');put('src/secret note.tmp','nested ignored file\n');
console.log(JSON.stringify({path:repo,revision},null,2));
