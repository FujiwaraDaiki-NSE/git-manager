import test from 'node:test';
import assert from 'node:assert/strict';
import { organizeInventory, inventoryKind, inventoryCsv, inventoryPathList, adjacentInventoryFiles } from '../app/repository-inventory-tools.mjs';
const entries = [
  {path:'src',type:'tree',mode:'040000',hash:null},
  {path:'z.ts',type:'blob',mode:'100644',hash:'abc'},
  {path:'a-link',type:'blob',mode:'120000',hash:'def'},
  {path:'module',type:'commit',mode:'160000',hash:'123'},
];
test('type filtering uses Git mode, sorting keeps source unchanged', () => {
  assert.equal(inventoryKind(entries[2]), 'symlink');
  assert.deepEqual(organizeInventory(entries,'file','path'),[entries[1]]);
  assert.deepEqual(organizeInventory(entries,'all','path-desc').map(x=>x.path),['z.ts','src','module','a-link']);
  assert.deepEqual(organizeInventory(entries,'all','kind'),entries);
  assert.equal(entries[0].path,'src');
  assert.throws(()=>organizeInventory(entries,undefined,'path'));
  assert.throws(()=>organizeInventory(entries,'all',null));
});
test('path list preserves control characters and CSV escapes spreadsheet formulas',()=>{
  const odd = [{path:'=x,"\nfile',type:'blob',mode:'100644',hash:'abc'}];
  assert.equal(JSON.parse(inventoryPathList(odd)),odd[0].path);
  const csv=inventoryCsv(odd,'resolved');
  assert.ok(csv.includes('"\'=x,""\nfile"'));
  assert.ok(inventoryCsv(entries,'resolved').includes('"src","directory","040000",""'));
  assert.throws(()=>inventoryCsv(entries,''));
});
test('adjacent navigation respects visible order and never wraps or selects a directory',()=>{
  assert.deepEqual(adjacentInventoryFiles(entries,'z.ts'),{index:0,count:3,previous:null,next:entries[2]});
  assert.equal(adjacentInventoryFiles(entries,'module').next,null);
  assert.deepEqual(adjacentInventoryFiles(entries,'missing'),{index:-1,count:3,previous:null,next:null});
  assert.equal(adjacentInventoryFiles([...entries].reverse(),'a-link').previous,entries[3]);
});
