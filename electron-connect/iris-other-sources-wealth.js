"use strict";
const VIEW="116 - Wealth Statement > Reconciliation of Net Assets";
/** Dedicated final-tax routes must not inherit generic 'first filled cell wins'. */
function readWealthTotals(tour,parseAmount,codes=["7033","703000"]) {
 const totals={},evidence={};
 const fail=reason=>({ok:false,reason,totals:{},evidence});
 if(!tour?.complete)return fail("wealth_tour_incomplete");
 const views=(tour.views||[]).filter(view=>view.key===VIEW);
 if(views.length!==1)return fail("wealth_reconciliation_view_missing_or_duplicate");
 for(const code of codes){
  const rows=(views[0].rows||[]).filter(row=>String(row.code)===code);
  if(rows.length!==1)return fail(`wealth_${code}_row_missing_or_duplicate`);
  const filled=(rows[0].cells||[]).map((cell,index)=>({raw:cell?.value,index})).filter(cell=>cell.raw!==null&&cell.raw!==undefined&&String(cell.raw).trim()!=="");
  if(filled.length!==1)return fail(`wealth_${code}_amount_cell_missing_or_ambiguous`);
  const raw=filled[0].raw;
  // Generic IRIS parsing strips non-digits; dedicated evidence must instead
  // reject annotations/units/exponents rather than silently reinterpret them.
  const text=String(raw).trim();
  if(!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text))return fail(`wealth_${code}_amount_invalid`);
  const amount=typeof parseAmount==="function"?parseAmount(raw):Number(String(raw).replace(/,/g,""));
  if(!Number.isFinite(amount))return fail(`wealth_${code}_amount_invalid`);
  totals[code]=amount;evidence[code]={view:VIEW,columnIndex:filled[0].index,raw:String(raw)};
 }
 return {ok:true,reason:"wealth_exact_rows_verified",totals,evidence};
}
/** Read-only opening Wealth check shared by Dividend and Bank routes.
 * Prior assets are not current-year income; never add them to 7033 or write
 * an opening-balance/reconciliation plug. Asset disposals may legitimately
 * reduce current assets, so the old aggregate carry heuristic is not a gate.
 */
function checkPreviousReturn(snapshot,tour,parseAmount) {
 const expected=snapshot?.wealthExpectations?.previousYearNetAssets;
 const carry=snapshot?.wealthCarryForward;
 if(!expected&&!carry)return {ok:true,required:false,reason:"previous_return_not_provided"};
 const fail=reason=>({ok:false,required:true,reason});
 if(!expected||expected.irisCode!=="703002"||expected.source!=="approved_previous_return_703001"||!Number.isSafeInteger(expected.expected)||(!Number.isSafeInteger(expected.previousReturnTaxYear)||expected.previousReturnTaxYear>=Number(snapshot?.filing?.taxYear)||!Number.isSafeInteger(snapshot?.filing?.taxYear)))
   return fail("Previous Return opening Wealth contract is invalid; review the approved previous-year return.");
 if(carry&&(carry.previousReturnTaxYear!==expected.previousReturnTaxYear||carry.netAssets!==expected.expected||!Number.isSafeInteger(carry.totalAssets)||!Number.isSafeInteger(carry.totalLiabilities)||carry.totalAssets-carry.totalLiabilities!==carry.netAssets))
   return fail("Previous Return carry-forward totals disagree with its approved opening net assets.");
 const proof=readWealthTotals(tour,parseAmount,["703002"]);
 if(!proof.ok)return {...fail("Previous Return needs an exact unique 703002 readback; nothing was changed."),proof};
 const actual=proof.totals["703002"];
 return {ok:actual===expected.expected,required:true,expected:expected.expected,actual,proof,reason:actual===expected.expected?"previous_return_opening_wealth_verified":"IRIS 703002 differs from the approved Previous Return closing net assets; Save/completion is blocked. Nothing was changed."};
}
module.exports={readWealthTotals,checkPreviousReturn};
