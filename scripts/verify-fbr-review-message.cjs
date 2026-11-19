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
 for(const text of ['Last agent report','<details','UI test','onStartOver()'])assert.equal(branch.includes(text),false);
 assert.ok(branch.includes('last agent check'));
 assert.ok(branch.includes('Continuing is blocked'));
});

test('restart closes only paused job then returns to Start without automatic queue or resume',()=>{
 const s=fs.readFileSync('components/tax/fbr-connect-client.tsx','utf8');
 const b=s.slice(s.indexOf('  async function handleRestartPausedHandoff'),s.indexOf('  async function handleResumeJob'));
 assert.ok(b.includes('window.confirm'));assert.ok(b.includes('await cancelJobAction(jobId)'));
 assert.ok(b.includes('setStartOver(true)'));assert.ok(b.includes('await refreshJobs()'));
 assert.ok(b.indexOf('if (!result.success)')<b.indexOf('setStartOver(true)'));
 assert.equal(b.includes('queueAssistedFilingJobAction'),false);assert.equal(b.includes('resumeJobAfterPauseAction'),false);
 assert.ok(s.includes('disabled={restarting} onClick={onStartOver}'));
});
