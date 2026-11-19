const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const source=fs.readFileSync('lib/tax/fbr-review-message.ts','utf8');const mod={exports:{}};
new Function('exports','module',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod.exports,mod);
const fn=mod.exports.completedEntryReview;
const message='12/12 approved field(s) were entered and read back, but the return is not complete: Dividend Wealth readback must show certified gross on 7033 and zero on 703000.';
test('completed entry is distinguished from missing amounts',()=>assert.deepEqual(fn('portal_autofill_review',message),{count:12}));
for(const [label,action,text,attention]of [['partial','portal_autofill_review',message.replace('12/12','11/12'),false],['empty','portal_autofill_review','',false],['attention','portal_autofill_review',message,true],['other pause','portal_business_retry',message,false],['zero','portal_autofill_review',message.replace('12/12','0/0'),false]])test(label,()=>assert.equal(fn(action,text,attention),null));
test('paused verified entry reuses completion card without changing job status',()=>{
 const ui=fs.readFileSync('components/tax/fbr-connect-client.tsx','utf8');
 assert.ok(ui.includes('pendingEntryReview={{ count: completedEntry.count'));
 assert.ok(ui.includes('!completedEntry &&\n        !isFinalSubmitPause'));
 const branch=ui.slice(ui.indexOf('  if (pendingEntryReview) {'),ui.indexOf('  const rows:',ui.indexOf('  if (pendingEntryReview) {')));
 assert.ok(branch.includes('text-amber-600'));
 assert.ok(branch.indexOf('IRIS totals need review.')<branch.indexOf('<CardHeader'));
 for(const text of ['title="Data entry"','title="IRIS totals and reconciliation"','title="Draft Save"','title="Submission"'])assert.ok(branch.includes(text));
 for(const text of ['<Button','Last agent report','<details','UI test','onStartOver()'])assert.equal(branch.includes(text),false);
 assert.ok(branch.includes('last agent check'));
 assert.ok(branch.includes('Continuing is blocked'));
});
