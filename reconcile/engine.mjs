export const currencies = {USD:2, GBP:2, EUR:2, CAD:2, AUD:2, INR:2, JPY:0};
const dayMs = 86400000;
const maxMinor = 999999999999;
const aliases = {
  invoice:'Invoice', inv:'Invoice', bill:'Invoice', debit:'Debit note', 'debit note':'Debit note',
  credit:'Credit note', 'credit note':'Credit note', 'credit memo':'Credit note', refund:'Credit note',
  payment:'Payment', 'supplier payment':'Payment', adjustment:'Adjustment'
};
export const original = cell => typeof cell === 'object' && cell !== null ? cell.text : String(cell ?? '');
export const normalize = value => String(value ?? '').normalize('NFC').trim().toUpperCase();

export function parseAmount(cell, {decimal, thousands, digits, currency, currencyStyle='plain'}) {
  if(cell?.formula) throw Error('Formula cell. Export values from the source application.');
  const typed = typeof cell?.number === 'number';
  let text = (typed ? String(cell.number) : original(cell)).trim().replace(/[\u00a0\u202f]/g,' ');
  if (!text) throw Error('Amount is blank.');
  let negative = false;
  if(text.startsWith('(') && text.endsWith(')')){
    negative=true; text=text.slice(1,-1).trim();
  }else if(/^[+-]/.test(text)){
    negative=text[0]==='-';text=text.slice(1).trim();
  }
  if(!typed&&currencyStyle==='marked'){
    const symbol={USD:'$',CAD:'CA$',AUD:'A$',GBP:'£',EUR:'€',INR:'₹',JPY:'¥'}[currency];
    const tokens=[currency,symbol,...(['CAD','AUD'].includes(currency)?['$']:[])].filter(Boolean);
    const prefix=tokens.find(t=>text.startsWith(t));
    if(prefix)text=text.slice(prefix.length).trim();
    else{
      const suffix=tokens.find(t=>text.endsWith(t));
      if(suffix)text=text.slice(0,-suffix.length).trim();
    }
  }
  const dp=typed?'.':decimal, sep=typed?'':thousands;
  const pieces=text.split(dp);
  let integer=pieces[0], fraction=pieces[1]??'';
  if(pieces.length>2 || (pieces.length===2&&!/^\d+$/.test(fraction)))throw Error('Invalid decimal amount.');
  if(sep&&integer.includes(sep)){
    const groups=integer.split(sep);
    if(!/^\d{1,3}$/.test(groups[0])||groups.slice(1).some(group=>!/^\d{3}$/.test(group)))throw Error('Invalid thousands grouping.');
    integer=groups.join('');
  }
  if(!/^\d+$/.test(integer))throw Error('Invalid amount or currency marker.');
  if(fraction.slice(digits).match(/[1-9]/))throw Error('Amount has too many decimal places for the currency.');
  fraction=fraction.slice(0,digits).padEnd(digits,'0');
  const minor=Number(integer+fraction);
  if(!Number.isSafeInteger(minor)||minor>maxMinor)throw Error('Amount exceeds the supported range.');
  return negative&&minor?-minor:minor;
}

export function parseDate(cell, order='iso') {
  const text=cell?.date || original(cell).trim();
  if(!text)return null;
  let parts=/^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  let year,month,day;
  if(parts){[,year,month,day]=parts.map(Number);}
  else{
    parts=/^(\d{1,2})([\/.-])(\d{1,2})\2(\d{4})$/.exec(text);
    if(!parts||order==='iso')throw Error('Date does not match the selected format.');
    year=Number(parts[4]);
    [month,day]=(order==='mdy'?[parts[1],parts[3]]:[parts[3],parts[1]]).map(Number);
  }
  const value=new Date(Date.UTC(year,month-1,day));
  if(year<1900||value.getUTCFullYear()!==year||value.getUTCMonth()!==month-1||value.getUTCDate()!==day)throw Error('Invalid calendar date.');
  return {iso:value.toISOString().slice(0,10), day:value.getTime()/dayMs};
}

export function validateConfig(config, tables){
  if(!config.supplier?.trim()||config.supplier.length>120)throw Error('Enter a supplier name.');
  if(!Object.hasOwn(currencies,config.currency))throw Error('Select a supported currency.');
  if(!['open','period'].includes(config.mode)||!['balance','original'].includes(config.basis))throw Error('Select the reconciliation type and amount basis.');
  const cutoff=parseDate(config.cutoff), start=config.mode==='period'?parseDate(config.start):null;
  if(!cutoff||config.mode==='period'&&(!start||start.day>cutoff.day))throw Error('Enter a valid reporting period.');
  if(!['export','date'].includes(config.scope)||!config.compatible)throw Error('Confirm that both files use the same supplier, currency, scope, and amount basis.');
  if(config.mode==='open'&&config.scope!=='export')throw Error('Open balances must come from exports already prepared as of the cutoff.');
  for(const side of ['statement','ledger']){
    const map=config.maps[side], width=tables[side].headers.length;
    const keys=['ref','date','type','supplier',...(map.amountMode==='split'?['debit','credit']:['amount'])];
    const selected=keys.map(key=>map[key]).filter(index=>index!==-1);
    if(selected.some(index=>!Number.isInteger(index)||index<0||index>=width)||new Set(selected).size!==selected.length)throw Error(side+': map each field to a different available column.');
    if(map.ref<0||!['signed','split'].includes(map.amountMode)||(map.amountMode==='split'?(map.debit<0||map.credit<0):map.amount<0))throw Error(side+': map the reference and amount columns.');
    if(map.date<0&&config.scope==='date')throw Error(side+': map a date column or use already-filtered exports.');
    if(map.supplier>=0&&!map.supplierValue?.trim())throw Error(side+': enter the supplier value expected in the mapped column.');
    if(!['.',','].includes(map.decimal)||!['',',','.',' ','\''].includes(map.thousands)||map.decimal===map.thousands||![1,-1].includes(map.sign)||!['iso','mdy','dmy'].includes(map.dateOrder))throw Error(side+': check the number, date, and sign settings.');
  }
  return {cutoff,start,digits:currencies[config.currency]};
}

export function normalizeRow(input, side, index, config, scope) {
  const map=config.maps[side];
  const cell=key=>input.cells[map[key]];
  const value=key=>original(cell(key));
  const record={id:side[0]+(index+1),side,source:input.source,values:input.cells.map(original),
    reference:value('ref'), originalDate:value('date'), originalType:value('type'), originalSupplier:value('supplier'),
    originalAmount:map.amountMode==='split'?'Debit: '+value('debit')+' | Credit: '+value('credit'):value('amount'),
    key:normalize(value('ref')),date:null,amount:null,type:'',disposition:'Ready',reason:''};
  try{
    const fields=['ref','date','type','supplier',...(map.amountMode==='split'?['debit','credit']:['amount'])];
    if(fields.some(key=>cell(key)?.formula))throw Error('Mapped cell contains a formula. Supply a values-only export.');
    if(record.reference.length>256)throw Error('Document reference exceeds 256 characters.');
    if(map.supplier>=0&&normalize(record.originalSupplier)!==normalize(map.supplierValue)){
      record.disposition='Out of scope';record.reason='Supplier does not match the confirmed supplier value.';return record;
    }
    record.date=parseDate(cell('date'),map.dateOrder);
    if(config.scope==='date'){
      if(!record.date)throw Error('Date is required for filtering.');
      if(record.date.day>scope.cutoff.day||scope.start&&record.date.day<scope.start.day){
        record.disposition='Out of scope';record.reason='Transaction date falls outside the selected period.';return record;
      }
    }
    const format={...map,digits:scope.digits,currency:config.currency};
    if(map.amountMode==='split'){
      if(!value('debit').trim()&&!value('credit').trim())throw Error('Both debit and credit are blank.');
      const debit=value('debit').trim()?parseAmount(cell('debit'),format):0;
      const credit=value('credit').trim()?parseAmount(cell('credit'),format):0;
      if(debit<0||credit<0||debit&&credit)throw Error('Debit and credit columns must be nonnegative with at most one nonzero value.');
      record.amount=(debit-credit)*map.sign;
    }else record.amount=parseAmount(cell('amount'),format)*map.sign;
    if(record.originalType.trim()){
      const key=record.originalType.trim().toLowerCase();
      record.type=Object.hasOwn(aliases,key)?aliases[key]:'';
      if(!record.type)throw Error('Unrecognized transaction type. Map a supported type or leave the type column unmapped.');
    }else record.type=record.amount<0?'Credit note':'Invoice';
    if(!record.key)record.reason='Document reference is missing.';
    return record;
  }catch(error){
    record.disposition='Invalid';record.reason=error.message;return record;
  }
}

export function reconcile(tables,config,onProgress=()=>{}) {
  const scope=validateConfig(config,tables);
  const records=[], byRef=new Map(), result=[];
  const add=(category,statement,ledger,reason,evidence='Unresolved')=>{
    const id='R'+(result.length+1);
    const statementIds=statement.map(row=>row.id),ledgerIds=ledger.map(row=>row.id);
    result.push({id,category,statementIds,ledgerIds,reason,evidence,
      difference:statement.length===1&&ledger.length===1&&Number.isInteger(statement[0].amount)&&Number.isInteger(ledger[0].amount)?statement[0].amount-ledger[0].amount:null});
    for(const row of [...statement,...ledger]){
      if(row.disposition==='Invalid')continue;
      row.disposition=category;row.resultId=id;
    }
  };
  const total=tables.statement.rows.length+tables.ledger.rows.length;
  const without=[],invalidByRef=new Map();
  for(const side of ['statement','ledger']){
    for(const [i,input] of tables[side].rows.entries()){
      const record=normalizeRow(input,side,i,config,scope);
      records.push(record);
      if(records.length%100===0)onProgress(records.length,total);
      if(record.disposition!=='Ready'){
        if(record.disposition==='Invalid'&&record.key){
          if(!invalidByRef.has(record.key))invalidByRef.set(record.key,{statement:[],ledger:[]});
          invalidByRef.get(record.key)[side].push(record);
        }
        continue;
      }
      if(!record.key){without.push(record);continue;}
      if(!byRef.has(record.key))byRef.set(record.key,{statement:[],ledger:[]});
      byRef.get(record.key)[side].push(record);
    }
  }
  const unmatched=[];
  const one=(row,reason)=>{
    const a=row.side==='statement'?[row]:[],b=row.side==='ledger'?[row]:[];
    const category=row.type==='Credit note'?'Credit review':!row.key?'Reference review':row.side==='statement'?'Missing in ledger':'Missing on statement';
    add(category,a,b,reason);
    unmatched.push(row);
  };
  for(const [key,{statement:a,ledger:b}] of byRef){
    const invalid=invalidByRef.get(key);
    if(a.length+(invalid?.statement.length||0)>1||b.length+(invalid?.ledger.length||0)>1){
      add('Duplicate review',[...a,...(invalid?.statement||[])],[...b,...(invalid?.ledger||[])],'Reference occurs more than once on at least one side.');
      continue;
    }
    if(invalid){
      add('Reference review',[...a,...invalid.statement],[...b,...invalid.ledger],'A counterpart with the same reference has invalid source fields.');continue;
    }
    if(!a.length||!b.length){one(a[0]||b[0],'No matching reference on the other side. Check timing and allocation.');continue;}
    if(a[0].type!==b[0].type){add('Credit review',a,b,'Transaction types disagree.');continue;}
    if(a[0].amount!==b[0].amount){add('Amount mismatch',a,b,'Unique reference and type agree, but signed amounts differ.');continue;}
    add('Matched',a,b,'Unique reference, transaction type, and signed amount agree.','Exact');
  }
  for(const row of without)one(row,'Document reference is missing. Verify the source row.');
  const byAmountDate=new Map();
  for(const row of unmatched){
    if(row.side!=='ledger'||!row.date||!row.amount)continue;
    const key=[row.type,row.amount,row.date.day].join('|');
    if(!byAmountDate.has(key))byAmountDate.set(key,{ids:[],count:0});
    const group=byAmountDate.get(key);
    group.count++;
    if(group.ids.length<5)group.ids.push(row.id);
  }
  const suggestions=[];
  for(const row of unmatched){
    if(row.side!=='statement'||!row.date||!row.amount)continue;
    const candidates=[];
    let count=0;
    for(const offset of [0,-1,1,-2,2,-3,3]){
      const group=byAmountDate.get([row.type,row.amount,row.date.day+offset].join('|'));
      if(group){count+=group.count;candidates.push(...group.ids);}
    }
    if(count)suggestions.push({id:'S'+(suggestions.length+1),statementId:row.id,candidateIds:candidates.slice(0,5),count,
      reason:'Same transaction type and signed amount, with document dates within three days. Review before confirming.',evidence:'Suggested'});
  }
  onProgress(total,total);
  return {records,result,suggestions,config:{...config},digits:scope.digits};
}

export function reviewIndex(run, decisions=[], pairs=[]) {
  const rows=new Map(run.records.map(row=>[row.id,row]));
  const occupied=new Set(run.result.filter(group=>group.category==='Matched').flatMap(group=>[...group.statementIds,...group.ledgerIds]));
  const byResult=new Map(run.result.map(item=>[item.id,item]));
  const bySuggestion=new Map(run.suggestions.map(item=>[item.id,item]));
  const actions=new Map();
  for(const action of decisions){
    if(!byResult.has(action.id)&&!bySuggestion.has(action.id))throw Error('Unknown review item.');
    if(byResult.get(action.id)?.category==='Matched')throw Error('An exact match does not need an exception decision.');
    if(!['Unresolved','Dismissed'].includes(action.status))throw Error('Invalid review decision.');
    actions.set(action.id,{...action,note:String(action.note??'').slice(0,1000)});
  }
  for(const pair of pairs){
    const a=rows.get(pair.statementId),b=rows.get(pair.ledgerId);
    if(a?.side!=='statement'||b?.side!=='ledger'||!a.resultId||!b.resultId)throw Error('Choose two in-scope records to confirm.');
    if(occupied.has(a.id)||occupied.has(b.id))throw Error('A row is already part of a confirmed match.');
    if(pair.suggestionId){
      const suggestion=bySuggestion.get(pair.suggestionId);
      if(suggestion?.statementId!==a.id||!suggestion.candidateIds.includes(b.id)||actions.get(suggestion.id)?.status==='Dismissed')throw Error('This suggestion is no longer available.');
    }
    occupied.add(a.id);occupied.add(b.id);
  }
  const status=group=>{
    const ids=[...group.statementIds,...group.ledgerIds];
    if(group.category==='Matched'||ids.every(id=>occupied.has(id)))return 'Confirmed';
    if(actions.get(group.id)?.status==='Dismissed')return 'Dismissed';
    return ids.some(id=>occupied.has(id))?'Partially confirmed':'Unresolved';
  };
  return {rows,occupied,actions,status};
}

export function summarize(run, review) {
  const counts={};
  for(const group of run.result)counts[group.category]=(counts[group.category]||0)+1;
  const sources={statement:{rows:0,total:0,invalid:0,excluded:0},ledger:{rows:0,total:0,invalid:0,excluded:0}};
  for(const row of run.records){
    const side=sources[row.side];
    side.rows++;
    if(row.disposition==='Invalid')side.invalid++;
    else if(row.disposition==='Out of scope')side.excluded++;
    else side.total+=row.amount;
  }
  return {sources,counts,unresolved:run.result.filter(group=>['Unresolved','Partially confirmed'].includes(review.status(group))).length+
    sources.statement.invalid+sources.ledger.invalid};
}
