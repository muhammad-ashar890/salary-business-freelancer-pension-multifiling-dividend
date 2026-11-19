const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const source=fs.readFileSync('lib/tax/fbr-review-message.ts','utf8');const mod={exports:{}};
new Function('exports','module',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod.exports,mod);
const fn=mod.exports.completedEntryReview;
const message='12/12 approved field(s) were entered and read back, but the return is not complete: Dividend Wealth readback must show certified gross on 7033 and zero on 703000.';
test('completed entry is distinguished from missing amounts',()=>assert.deepEqual(fn('portal_autofill_review',message),{count:12}));
for(const [label,action,text,attention]of [['partial','portal_autofill_review',message.replace('12/12','11/12'),false],['empty','portal_autofill_review','',false],['attention','portal_autofill_review',message,true],['other pause','portal_business_retry',message,false],['zero','portal_autofill_review',message.replace('12/12','0/0'),false]])test(label,()=>assert.equal(fn(action,text,attention),null));
test('complete branch hides misleading acknowledgement/resume/reconnect; preserves ordinary review',()=>{
 const ui=fs.readFileSync('components/tax/fbr-connect-client.tsx','utf8');
 assert.ok(ui.includes('!completedEntry && ACKNOWLEDGEMENT_TEXT'));
 assert.ok(ui.includes('{!completedEntry && <Button'));
 assert.ok(ui.includes('{inspectionPause && !completedEntry && ('));
 assert.ok(ui.includes('not a live reading'));
 assert.ok(ui.includes('No read-only totals recheck is available'));
 assert.ok(fs.readFileSync('components/tax/wizard-ui.tsx','utf8').includes('No app checklist blockers. Live FBR checks may still need review.'));
});
