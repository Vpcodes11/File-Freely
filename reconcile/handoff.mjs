import {currencies,normalize,parseDate} from './engine.mjs';

export const actionStatuses=['Open','Awaiting supplier','Supplier responded','Resolved','Carried forward','Dismissed'];
export const requestCategories={
  'Missing invoice':'Please send a copy of this invoice.',
  'Missing credit note':'Please confirm whether this credit note has been issued and send a copy.',
  'Invoice amount clarification':'Please confirm the amount shown on the invoice and explain any adjustments.',
  'Credit allocation clarification':'Please confirm which invoice or payment this credit was applied to.',
  'Duplicate invoice clarification':'Please confirm whether these entries refer to the same invoice.',
  'Other query':''
};
export const messageDefaults={
  subject:'Request for clarification on supplier statement',
  greeting:'Hello,',
  intro:'Could you please help us with the following items?',
  closing:'Thank you for your assistance.\n\nRegards,\nAccounts Payable Team'
};
const exceptionCategories=['Amount mismatch','Missing in ledger','Missing on statement','Duplicate review','Credit review','Reference review','Invalid source row'];
const transactionTypes=['Invoice','Debit note','Credit note','Payment','Adjustment',''];
const format='filefreely-supplier-exceptions';
const version=1;
export const maxCarryBytes=12*1024*1024;
const maxItems=8000;
const maxHistory=120;
const unresolved=status=>status!=='Resolved'&&status!=='Dismissed';
const text=(value,max)=>typeof value==='string'&&value.length<=max;
const date=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  try{return Boolean(parseDate(value));}catch{return false;}
};
const hasFields=(value,fields)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const referenceFor=rows=>rows.find(row=>row.reference.trim())?.reference.trim()||'';
const evidenceFor=rows=>rows.map(row=>({
  side:row.side,reference:row.reference,amount:row.amount,date:row.date?.iso||'',type:row.type
}));

function validCarryFile(file){
  if(!hasFields(file,['format','version','supplier','currency','cutoff','basis','items'])||
     file.format!==format||file.version!==version||
     !text(file.supplier,360)||!file.supplier||normalize(file.supplier)!==file.supplier||
     !Object.hasOwn(currencies,file.currency)||!date(file.cutoff)||!['balance','original'].includes(file.basis)||
     !Array.isArray(file.items)||file.items.length>maxItems)return false;
  const ids=new Set();
  let evidenceCount=0;
  for(const item of file.items){
    if(!hasFields(item,['id','reference','category','reason','status','evidence','history'])||
       !text(item.id,24)||!/^\d{4}-\d{2}-\d{2}:(R|s|l)[1-9]\d{0,4}$/.test(item.id)||ids.has(item.id)||
       !text(item.reference,32767)||!exceptionCategories.includes(item.category)||!text(item.reason,500)||
       !actionStatuses.includes(item.status)||!Array.isArray(item.evidence)||!item.evidence.length||
       !Array.isArray(item.history)||!item.history.length||item.history.length>maxHistory)return false;
    ids.add(item.id);
    evidenceCount+=item.evidence.length;
    if(evidenceCount>16000||item.reference!==referenceFor(item.evidence.filter(row=>text(row?.reference,32767))))return false;
    for(const row of item.evidence){
      if(!hasFields(row,['side','reference','amount','date','type'])||!['statement','ledger'].includes(row.side)||
         !text(row.reference,32767)||(row.amount!==null&&(!Number.isSafeInteger(row.amount)||Math.abs(row.amount)>999999999999))||
         (row.date!==''&&!date(row.date))||!transactionTypes.includes(row.type))return false;
    }
    let prior='';
    for(const entry of item.history){
      if(!hasFields(entry,['cutoff','status'])||!date(entry.cutoff)||entry.cutoff<=prior||entry.cutoff>file.cutoff||
         !actionStatuses.includes(entry.status))return false;
      prior=entry.cutoff;
    }
    if(item.id.slice(0,10)!==item.history[0].cutoff||prior!==file.cutoff||item.history.at(-1).status!==item.status)return false;
  }
  return true;
}

export function parseCarryForward(contents){
  if(typeof contents!=='string'||contents.length>maxCarryBytes||new TextEncoder().encode(contents).length>maxCarryBytes)
    throw Error('Carry-forward files must be 12 MB or smaller.');
  let file;
  try{file=JSON.parse(contents);}catch{throw Error('Invalid carry-forward JSON.');}
  if(file?.format===format&&file.version!==version)throw Error('Unsupported carry-forward file version.');
  if(!validCarryFile(file))throw Error('Invalid carry-forward file structure.');
  return file;
}

export function checkCarryScope(file,config){
  if(file.supplier!==normalize(config.supplier))throw Error('The carry-forward file belongs to a different supplier. Use the same supplier name.');
  if(file.currency!==config.currency||file.basis!==config.basis)throw Error('The carry-forward currency and amount basis must match this reconciliation.');
  if(file.cutoff>=config.cutoff)throw Error('The carry-forward cutoff must be earlier than this reconciliation.');
}

function comparePrior(item,rows,groups){
  if(!item.reference)return {message:'Still unresolved. The previous record has no invoice reference to compare.',rows:[]};
  if(!rows.length)return {message:'Still unresolved. No matching reference appears in the current in-scope records.',rows};
  const previous=item.evidence;
  const bySide={statement:previous.filter(row=>row.side==='statement'),ledger:previous.filter(row=>row.side==='ledger')};
  const known=value=>value!==undefined&&value!==null&&value!=='';
  const changed=field=>['statement','ledger'].some(side=>{
    const old=bySide[side].length?bySide[side]:previous;
    const values=new Set(old.map(row=>row[field]).filter(known));
    return values.size>0&&rows.some(row=>{
      if(row.side!==side)return false;
      const value=field==='date'?row.date?.iso:row[field];
      return known(value)&&!values.has(value);
    });
  });
  if(changed('amount'))return {message:'Changed amount on the same reference. Review before carrying forward or resolving.',rows};
  if(changed('date')||changed('type'))return {message:'Changed date or transaction type on the same reference. Check for a reused reference.',rows};
  if(rows.some(row=>row.disposition==='Invalid'))return {message:'Still unresolved. A current record with this reference is invalid.',rows};
  const match=rows.length===2&&groups.get(rows[0].resultId)?.category==='Matched'&&rows[0].resultId===rows[1].resultId;
  if(match&&previous.every(row=>row.amount!==null)&&previous.some(row=>row.amount===rows[0].amount&&row.type===rows[0].type))
    return {message:'Potential resolution. Current statement and ledger agree and the historical amount and type corroborate. Review before closing.',rows};
  return {message:'Still unresolved. Review the current records for this reference.',rows};
}

export function createRegister(run,file=null){
  if(file)checkCarryScope(file,run.config);
  const rows=new Map(run.records.map(row=>[row.id,row]));
  const groups=new Map(run.result.map(group=>[group.id,group]));
  const items=[];
  const grouped=new Set();
  for(const group of run.result){
    if(group.category==='Matched')continue;
    const originals=[...group.statementIds,...group.ledgerIds].map(id=>rows.get(id));
    originals.forEach(row=>grouped.add(row.id));
    items.push({
      id:run.config.cutoff+':'+group.id,groupId:group.id,reference:referenceFor(originals),category:group.category,
      reason:group.reason,status:'Open',originals,evidence:evidenceFor(originals),history:[],note:'',resolution:''
    });
  }
  for(const row of run.records){
    if(row.disposition!=='Invalid'||grouped.has(row.id))continue;
    items.push({
      id:run.config.cutoff+':'+row.id,groupId:row.id,reference:row.reference.trim(),category:'Invalid source row',
      reason:row.reason,status:'Open',originals:[row],evidence:evidenceFor([row]),history:[],note:'',resolution:''
    });
  }
  if(!file)return items;
  const current=new Map();
  for(const row of run.records){
    if(!row.key||row.disposition==='Out of scope')continue;
    if(!current.has(row.key))current.set(row.key,[]);
    current.get(row.key).push(row);
  }
  // Merge only a unique current and historical exception with identical categorized evidence.
  // A reused reference, changed amount, or ambiguous group stays separate for review.
  const signature=item=>JSON.stringify([item.category,item.evidence.map(row=>
    JSON.stringify([row.side,normalize(row.reference),row.amount,row.date,row.type])).sort()]);
  const currentSignatures=new Map();
  for(const item of items){
    const key=signature(item);
    currentSignatures.set(key,currentSignatures.has(key)?null:item);
  }
  const active=file.items.filter(item=>unresolved(item.status));
  const historicalCounts=new Map();
  for(const item of active){
    const key=signature(item);
    historicalCounts.set(key,(historicalCounts.get(key)||0)+1);
  }
  const merged=new Set();
  const history=active.map(item=>{
    const key=signature(item);
    const same=item.reference&&historicalCounts.get(key)===1?currentSignatures.get(key):null;
    if(same)merged.add(same.id);
    const comparison=comparePrior(item,current.get(normalize(item.reference))||[],groups);
    return {...item,previousStatus:item.status,status:'Carried forward',note:'',resolution:'',
      groupId:same?.groupId||'',originals:same?.originals||[],comparison};
  });
  return [...history,...items.filter(item=>!merged.has(item.id))];
}

export function buildCarryForward(config,items){
  const file={
    format,version,supplier:normalize(config.supplier),currency:config.currency,cutoff:config.cutoff,basis:config.basis,
    items:items.filter(item=>unresolved(item.status)).map(item=>({
      id:item.id,reference:item.reference,category:item.category,reason:item.reason,status:item.status,
      evidence:item.evidence,history:[...item.history,{cutoff:config.cutoff,status:item.status}]
    }))
  };
  if(!validCarryFile(file))throw Error('The action register exceeds the carry-forward limits. Use a smaller set of open items or save the internal workbook.');
  const contents=JSON.stringify(file);
  if(new TextEncoder().encode(contents).length>maxCarryBytes)throw Error('The carry-forward file exceeds 12 MB. Save the internal workbook or carry fewer items.');
  return contents;
}

const singleLine=value=>String(value??'').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,' ').trim();
const editableText=(value,max)=>String(value??'').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,max);

// This allowlist is the only bridge from an internal action to a supplier request.
// Date and amount, if chosen, always come from one explicitly selected statement row.
export function approveRequest(item,choice,currency){
  const reference=singleLine(item.reference);
  if(choice.approved!==true||!reference||reference.length>256||!Object.hasOwn(requestCategories,choice.category)||
     !unresolved(item.status)||item.category==='Invalid source row')
    throw Error('Choose a category and explicitly approve the invoice reference.');
  const explanation=editableText(choice.explanation,1000);
  if(!explanation)throw Error('Enter a supplier-facing request.');
  const request={reference,category:choice.category,explanation};
  if(choice.includeDate||choice.includeAmount){
    const row=item.originals.find(row=>row.id===choice.statementId&&row.side==='statement'&&row.disposition!=='Invalid');
    if(!row)throw Error('Choose the supplier statement row to share.');
    if(choice.includeDate){
      if(!date(row.date?.iso))throw Error('This statement row has no approved transaction date.');
      request.date=row.date.iso;
    }
    if(choice.includeAmount){
      if(!Number.isSafeInteger(row.amount))throw Error('This statement row has no approved amount.');
      request.amount=new Intl.NumberFormat('en-US',{style:'currency',currency}).format(row.amount/10**currencies[currency]);
    }
  }
  return Object.freeze(request);
}

export function requestText(request){
  const details=[request.date,request.amount].filter(Boolean);
  return request.category+' — '+request.reference+(details.length?' ('+details.join(' · ')+')':'')+': '+request.explanation;
}

export function supplierMessage({supplier,period},requests,edits={}){
  if(!requests.length)return '';
  const subject=singleLine(edits.subject).slice(0,180)||messageDefaults.subject;
  const greeting=editableText(edits.greeting,240)||messageDefaults.greeting;
  const intro=editableText(edits.intro,1000)||messageDefaults.intro;
  const closing=editableText(edits.closing,500)||messageDefaults.closing;
  return [
    'Subject: '+subject,greeting,'We are reviewing the statement for '+singleLine(supplier)+' for '+singleLine(period)+'.',intro,
    requests.map((request,index)=>(index+1)+'. '+requestText(request)).join('\n\n'),closing
  ].join('\n\n');
}

export const registerHeaders=['Exception ID','Invoice reference','Category','Original automated result','Current status','Internal note',
  'Resolution note','Carry-forward indicator','Source references','Original statement amounts','Original ledger amounts','Reviewer',
  'Previous status','Carry-forward history','Current comparison','Historical matching evidence'];
export function registerRows(items){
  const join=values=>{
    const value=values.join('\n');
    return value.length<=32000?value:value.slice(0,31940)+'… See Exceptions and Source Rows for complete current evidence.';
  };
  return items.map(item=>[
    item.id,item.reference,item.category,item.category+' · '+item.reason,item.status,item.note,item.resolution,
    item.history.length?'Yes':'No',
    join((item.originals.length?item.originals:item.comparison?.rows||[]).map(row=>row.side+' · '+row.source)),
    ...['statement','ledger'].map(side=>join(item.originals.filter(row=>row.side===side).map(row=>row.originalAmount))),
    item.reviewer||'',item.previousStatus||'',join(item.history.map(entry=>entry.cutoff+' · '+entry.status)),
    item.comparison?.message||'',
    item.history.length?join(item.evidence.map(row=>[row.side,row.reference,row.date,row.type,row.amount===null?'':row.amount+' minor units'].join(' · '))):''
  ]);
}
