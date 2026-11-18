import {original,reviewIndex,summarize} from './engine.mjs';
import {registerHeaders} from './handoff.mjs';
const currencyValue=(value,digits)=>value==null?'':value/10**digits;
const baseDetails=(row)=>row?[row.reference,row.originalDate,row.originalAmount,row.source,row.type,row.id]:['','','','','',''];

export function buildWorkbook(run,tables,decisions,pairs,xlsx=globalThis.XLSX,actionRows){
  const review=reviewIndex(run,decisions,pairs);
  const summary=summarize(run,review),digits=run.digits;
  const a=summary.sources.statement,b=summary.sources.ledger;
  const config=run.config;
  const outA=tables.statement.excluded.length,outB=tables.ledger.excluded.length;
  const rows=[
    ['FileFreely Reconcile','Value'],['Supplier',config.supplier],['Currency',config.currency],['Cutoff',config.cutoff],
    ['Period start',config.mode==='period'?config.start:''],['Amount basis',config.basis==='balance'?'Outstanding balance':'Original invoice amount'],
    ['Reconciliation type',config.mode==='open'?'Open items':'Period activity'],
    ['Scope confirmation',config.scope==='export'?'Exports confirmed already filtered':'Rows filtered by mapped date'],
    ['Statement imported records',a.rows],['Ledger imported records',b.rows],
    ['Statement table-excluded lines',outA],['Ledger table-excluded lines',outB],
    ['Statement signed valid in-scope total',currencyValue(a.total,digits)],['Ledger signed valid in-scope total',currencyValue(b.total,digits)],
    ['Signed total difference (statement minus ledger)',currencyValue(a.total-b.total,digits)],
    ['Statement invalid',a.invalid],['Ledger invalid',b.invalid],
    ['Statement scope exclusions',a.excluded],['Ledger scope exclusions',b.excluded],
    ...Object.entries(summary.counts).map(([key,count])=>['Automated groups: '+key,count]),
    ['Suggested groups (supplemental)',run.suggestions.length],['Manually confirmed pairs',pairs.length],
    ['Unresolved groups and invalid rows',summary.unresolved],
    ['Statement original headers',...tables.statement.headers],['Ledger original headers',...tables.ledger.headers],
    ['Interpretation','Missing rows may reflect timing, allocation, or report scope. Review before posting any changes.']
  ];
  const both=['Statement reference','Statement original date','Statement original amount','Statement source','Statement type','Statement row ID',
    'Ledger reference','Ledger original date','Ledger original amount','Ledger source','Ledger type','Ledger row ID'];
  const exceptions=[['Group','Category','Reason',...both,'Signed difference','Evidence','Current status','Reviewer decision','Reviewer note']];
  const matched=[['Group',...both,'Statement signed amount','Ledger signed amount','Difference','Rule','Confirmation','Reviewer note']];
  const pairByRow=new Map();
  for(const pair of pairs){pairByRow.set(pair.statementId,pair);pairByRow.set(pair.ledgerId,pair);}
  for(const group of run.result){
    const action=review.actions.get(group.id);
    const status=review.status(group);
    const row=(a,b)=>{
      const manual=[...new Set([a,b].filter(Boolean).map(row=>pairByRow.get(row.id)).filter(Boolean))];
      const decision=[action?.status,...manual.map(pair=>'Confirmed '+pair.statementId+' + '+pair.ledgerId)].filter(Boolean).join(' | ');
      const note=[action?.note,...manual.map(pair=>pair.note)].filter(Boolean).join(' | ');
      exceptions.push([group.id,group.category,group.reason,...baseDetails(a),...baseDetails(b),
        currencyValue(group.difference,digits),group.evidence,status,decision,note]);
    };
    if(group.category==='Matched'){
      const a=review.rows.get(group.statementIds[0]),b=review.rows.get(group.ledgerIds[0]);
      matched.push([group.id,...baseDetails(a),...baseDetails(b),currencyValue(a.amount,digits),currencyValue(b.amount,digits),0,group.reason,'Exact','']);
    }else if(group.statementIds.length<=1&&group.ledgerIds.length<=1)row(review.rows.get(group.statementIds[0]),review.rows.get(group.ledgerIds[0]));
    else{
      for(const id of group.statementIds)row(review.rows.get(id),null);
      for(const id of group.ledgerIds)row(null,review.rows.get(id));
    }
  }
  for(const row of run.records.filter(row=>row.disposition==='Invalid')){
    exceptions.push([row.id,'Invalid source row',row.reason,...baseDetails(row.side==='statement'?row:null),...baseDetails(row.side==='ledger'?row:null),'','Unresolved','Unresolved','','']);
  }
  for(const suggestion of run.suggestions){
    const a=review.rows.get(suggestion.statementId),action=review.actions.get(suggestion.id);
    for(const id of suggestion.candidateIds){
      const pair=pairByRow.get(a.id);
      const confirmed=pair?.ledgerId===id;
      const status=confirmed?'Confirmed':action?.status==='Dismissed'?'Dismissed':
        review.occupied.has(a.id)||review.occupied.has(id)?'Unavailable':'Unresolved';
      exceptions.push([suggestion.id,'Suggested match',suggestion.reason+(suggestion.count>suggestion.candidateIds.length?' Showing '+suggestion.candidateIds.length+' of '+suggestion.count+' candidates.':''),
        ...baseDetails(a),...baseDetails(review.rows.get(id)),0,'Suggested',status,action?.status||'',action?.note||'']);
    }
  }
  for(const [i,pair] of pairs.entries()){
    const a=review.rows.get(pair.statementId),b=review.rows.get(pair.ledgerId);
    matched.push(['M'+(i+1),...baseDetails(a),...baseDetails(b),currencyValue(a.amount,digits),currencyValue(b.amount,digits),
      currencyValue(a.amount-b.amount,digits),pair.suggestionId?'Reviewed '+pair.suggestionId:'Reviewed manual pair','Manually confirmed',pair.note||'']);
  }
  const width=Math.max(tables.statement.headers.length,tables.ledger.headers.length);
  const source=[['Side','Row ID','Source location','Original reference','Normalized reference','Original date','Normalized date','Original amount',
    'Signed amount','Normalized type','Original supplier','Automated disposition','Reason','Automated group','Confirmed counterpart',
    ...Array.from({length:width},(_,i)=>'Original column '+(i+1))]];
  for(const row of run.records){
    const pair=pairByRow.get(row.id);
    source.push([row.side,row.id,row.source,row.reference,row.key,row.originalDate,row.date?.iso||'',row.originalAmount,
      currencyValue(row.amount,digits),row.type,row.originalSupplier,row.disposition,row.reason,row.resultId||'',
      pair?(row.side==='statement'?pair.ledgerId:pair.statementId):'',...row.values]);
  }
  for(const side of ['statement','ledger']){
    for(const row of tables[side].excluded)
      source.push([side,'',row.source,'','','','','','','','','Excluded from table',row.reason,'','',...row.cells.map(original)]);
  }
  const book=xlsx.utils.book_new();
  const sheets=[['Summary',rows],['Exceptions',exceptions],['Matched',matched],['Source Rows',source]];
  if(actionRows)sheets.push(['Action Register',[registerHeaders,...actionRows]]);
  for(const [name,values] of sheets){
    const sheet=xlsx.utils.aoa_to_sheet(values.map(row=>row.map(value=>{
      if(typeof value==='number')return value;
      const text=String(value??'');
      if(text.length>32767)throw Error('An exported value exceeds Excel’s cell size limit.');
      // Explicit string cells never become formulas, hyperlinks, or external workbook references.
      return {t:'s',v:text};
    })));
    sheet['!cols']=values[0].map((name,index)=>({wch:index===0?24:Math.min(44,Math.max(15,String(name).length+2))}));
    if(name!=='Summary')sheet['!autofilter']={ref:sheet['!ref']};
    xlsx.utils.book_append_sheet(book,sheet,name);
  }
  return xlsx.write(book,{type:'array',bookType:'xlsx',compression:true});
}
