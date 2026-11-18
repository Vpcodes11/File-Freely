import {currencies,normalize,normalizeRow,original,reviewIndex,summarize} from './engine.mjs';
import {connectHandoff} from './handoff-ui.mjs';
const $=id=>document.getElementById(id);
const sides=[['statement','Supplier statement'],['ledger','Accounts payable ledger']];
const prefKey='filefreely:reconcile:layout:1';
const state={statement:{},ledger:{}};
let prefs={},worker,pending,sequence=0,epoch=0,busy=false,run,review,page=0,selected;
let decisions=[],pairs=[];
try{prefs=JSON.parse(localStorage.getItem(prefKey))||{};}catch{}
$('remember').checked=Object.keys(prefs).length>0;
const node=(tag,text,cls)=>{
  const el=document.createElement(tag);
  if(text!==undefined)el.textContent=text;
  if(cls)el.className=cls;
  return el;
};
function download(contents,type,name){
  const url=URL.createObjectURL(new Blob([contents],{type}));
  const anchor=node('a');anchor.href=url;anchor.download=name;
  document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
const handoff=connectHandoff({$,node,download,money});
const clip=(value,n=130)=>String(value??'').length>n?String(value).slice(0,n-1)+'…':String(value??'');
const options=(el,values,choice)=>{
  el.replaceChildren(...values.map(([value,label])=>new Option(label,value)));
  if(choice!==undefined&&values.some(([value])=>String(value)===String(choice)))el.value=choice;
};
const field=(id,label,items)=>'<label>'+label+'<select id="'+id+'">'+items.map(([v,t])=>'<option value="'+v+'">'+t+'</option>').join('')+'</select></label>';
const columns=[['ref','Document reference'],['amount','Signed amount'],['debit','Debit'],['credit','Credit'],['date','Transaction date'],['type','Transaction type'],['supplier','Supplier identifier']];
const preferenceFields=['amountMode','sign','decimal','thousands','currencyStyle','dateOrder','delimiter','gap'];
const guesses={ref:/^(invoice( number| no\.?| reference| #)?|document( reference| no\.?| number)?|reference|ref)$/,
  amount:/^(amount|balance|outstanding( balance)?|signed amount|invoice amount|open amount)$/,date:/^(date|invoice date|document date|transaction date|posting date)$/,
  type:/^(type|document type|transaction type)$/,debit:/^debit( amount)?$/,credit:/^credit( amount)?$/};

function say(text,error=false){
  $('status').textContent=text;
  $('status').classList.toggle('rec-error',error);
}
function progress(data){
  const bar=$('progress');
  bar.hidden=!data;
  if(data?.total){bar.max=data.total;bar.value=data.current;}
  else bar.removeAttribute('value');
  if(data)say(data.message);
}
function send(action,args={},transfer=[]){
  if(pending)throw Error('Wait for the current operation.');
  if(!worker){
    worker=new Worker(new URL('./worker.js',import.meta.url));
    worker.onmessage=({data})=>{
      if(data.id!==pending?.id)return;
      if(data.progress){progress(data.progress);return;}
      const request=pending;pending=null;
      if(data.error)request.reject(Error(data.error));else request.resolve(data.data);
    };
    worker.onerror=()=>{
      const request=pending;pending=null;worker?.terminate();worker=null;
      request?.reject(Error('The local worker stopped. Clear the documents and try again.'));
    };
  }
  const id=++sequence;
  return new Promise((resolve,reject)=>{
    pending={id,resolve,reject};
    try{worker.postMessage({id,action,...args},transfer);}catch(error){pending=null;reject(error);}
  });
}
function controls(){
  for(const id of ['supplier','currency','mode','basis','start','cutoff','scope','compatible','remember'])$(id).disabled=busy;
  for(const [key] of sides){
    for(const el of $(key+'-source').querySelectorAll('button,input,select'))el.disabled=busy;
    $(key+'-extract').disabled=busy||!state[key].info;
    $(key+'-remove').disabled=busy||!state[key].file;
    for(const el of $(key+'-map').querySelectorAll('input,select'))el.disabled=busy||!state[key].table;
  }
  $('run').disabled=busy||!state.statement.table||!state.ledger.table;
  for(const id of ['export','print','manual','filter','query'])$(id).disabled=busy||!run;
  $('cancel').hidden=!busy;$('clear').disabled=busy;
  handoff.setBusy(busy);
}
async function task(message,action){
  if(busy)return;
  const current=epoch;
  busy=true;controls();progress({message});
  try{await action(()=>current===epoch);}
  catch(error){if(current===epoch)say(error.message,true);}
  finally{if(current===epoch){busy=false;progress(null);controls();}}
}
function clearRun(clearCarry=false){
  run=review=selected=null;decisions=[];pairs=[];page=0;
  if($('review-dialog').open)$('review-dialog').close();
  for(const id of ['summary-cards','rows','print-report','review-records','pair-fields'])$(id).replaceChildren();
  for(const id of ['result-scope','review-reason','review-status','pagination'])$(id).textContent='';
  $('review-note').value='';$('query').value='';$('results').hidden=true;
  handoff.reset(clearCarry===true);
}
function clearFiles(message){
  epoch++;const request=pending;pending=null;
  worker?.terminate();worker=null;request?.reject(Error('Cancelled.'));
  busy=false;
  for(const [key] of sides){
    state[key]={};$(key+'-file').value='';$(key+'-supplierValue').value='';updateSource(key);
  }
  for(const id of ['supplier','start','cutoff'])$(id).value='';
  $('compatible').checked=false;clearRun(true);progress(null);controls();say(message);
}
$('cancel').onclick=()=>clearFiles('Cancelled. Both documents and the review were cleared.');
$('clear').onclick=()=>clearFiles('Documents and review cleared.');

for(const [key,title] of sides){
  const id=name=>key+'-'+name;
  const panel=node('section',undefined,'rec-source');
  panel.id=id('source');
  panel.innerHTML='<h3>'+title+'</h3><div class="rec-drop" id="'+id('drop')+'"><label>Drop a file here or browse<input type="file" id="'+id('file')+'" accept="'+(key==='statement'?'.pdf,':'')+'.csv,.xlsx"></label></div>'+
    '<p id="'+id('status')+'" role="status"></p><button type="button" class="rec-secondary" id="'+id('remove')+'">Remove file</button>'+
    '<div id="'+id('options')+'" hidden><div class="rec-grid rec-fields"><label>Header row<input type="number" min="1" max="4001" value="1" id="'+id('header')+'"></label>'+
    '<label id="'+id('sheet-wrap')+'">Worksheet<select id="'+id('sheet')+'"></select></label><div id="'+id('csv-wrap')+'">'+
    field(id('delimiter'),'CSV delimiter',[['comma','Comma'],['semi','Semicolon'],['tab','Tab']])+'</div></div>'+
    '<div id="'+id('pdf-wrap')+'" class="rec-grid rec-fields"><label>First PDF page<input type="number" min="1" value="1" id="'+id('first')+'"></label>'+
    '<label>Last PDF page<input type="number" min="1" id="'+id('last')+'"></label><label>Last table row per page<input type="number" min="1" max="4001" placeholder="End of page" id="'+id('lastRow')+'"></label>'+
    field(id('gap'),'Column spacing',[['normal','Medium gaps'],['tight','Small gaps'],['wide','Large gaps']])+'</div>'+
    '<p class="rec-muted" id="'+id('hint')+'"></p><button id="'+id('extract')+'" type="button" class="rec-secondary">Preview '+(key==='statement'?'statement':'ledger')+'</button><div id="'+id('preview')+'"></div></div>';
  $('sources').append(panel);
  const map=node('section',undefined,'rec-map');map.id=id('map');
  map.innerHTML='<h3>'+title+' mapping</h3><div class="rec-grid rec-fields">'+
    field(id('amountMode'),'Amount columns',[['signed','One signed amount'],['split','Separate debit and credit']])+
    columns.map(([key,label])=>field(id(key),label,[['-1','Choose a column']])).join('')+
    field(id('sign'),'Sign convention',[['1','Keep signed amounts / debit minus credit'],['-1','Reverse signs / credit minus debit']])+
    field(id('decimal'),'Decimal separator',[['.','Period'],[',','Comma']])+
    field(id('thousands'),'Thousands separator',[[',','Comma'],['.','Period'],[' ','Space'],['apostrophe','Apostrophe'],['','None']])+
    field(id('currencyStyle'),'Currency markers',[['plain','Numbers only'],['marked','Allow selected currency symbol or code']])+
    field(id('dateOrder'),'Date format',[['iso','YYYY-MM-DD'],['mdy','Month/day/year'],['dmy','Day/month/year']])+
    '<label id="'+id('supplier-wrap')+'">Expected supplier identifier<input id="'+id('supplierValue')+'" maxlength="120" autocomplete="off"></label></div>'+
    '<p class="rec-muted" id="'+id('signed-preview')+'"></p>';
  $('mappings').append(map);
  for(const name of preferenceFields){
    const saved=prefs[key]?.[name],el=$(id(name));
    if(typeof saved==='string'&&[...el.options].some(option=>option.value===saved))el.value=saved;
  }
  if(Number.isInteger(prefs[key]?.header)&&prefs[key].header>=1&&prefs[key].header<=100)$(id('header')).value=prefs[key].header;
  $(id('file')).onchange=event=>{const files=[...event.target.files];event.target.value='';if(files.length)choose(key,files);};
  const drop=$(id('drop'));
  drop.ondragover=event=>{event.preventDefault();if(!busy)drop.classList.add('rec-drag');};
  drop.ondragleave=()=>drop.classList.remove('rec-drag');
  drop.ondrop=event=>{event.preventDefault();drop.classList.remove('rec-drag');if(!busy)choose(key,[...event.dataTransfer.files]);};
  $(id('remove')).onclick=()=>task('Removing file…',async active=>{
    await send('remove',{side:key});
    if(!active())return;
    state[key]={};$(id('supplierValue')).value='';$('compatible').checked=false;clearRun();updateSource(key);say('File removed.');
  });
  $(id('options')).onchange=()=>{
    if(!state[key].table)return;
    state[key].table=null;clearRun();updateSource(key);controls();say('Table settings changed. Preview the file again.');
  };
  $(id('extract')).onclick=()=>extract(key);
  map.oninput=()=>{clearRun();updateMapping(key);controls();};
  updateSource(key);
}
window.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});
window.addEventListener('drop',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});

function choose(key,files){
  if(busy)return;
  if(files.length!==1){say('Choose one file for each side.',true);return;}
  const file=files[0],type=file.name.split('.').at(-1).toLowerCase();
  if(!file.size||file.size>25*1024*1024||!(key==='statement'?['pdf','csv','xlsx']:['csv','xlsx']).includes(type)){
    say('Choose a supported non-empty '+(key==='statement'?'PDF, CSV, or XLSX':'CSV or XLSX')+' file up to 25 MiB.',true);return;
  }
  state[key]={file};$('compatible').checked=false;$(key+'-supplierValue').value='';
  clearRun();updateSource(key);
  task('Opening '+key+' locally…',async active=>{
    try{
      const buffer=await file.arrayBuffer();
      if(!active())return;
      const info=await send('load',{side:key,type,buffer},[buffer]);
      if(!active())return;
      state[key].info=info;
      if(info.sheets)options($(key+'-sheet'),info.sheets.map(name=>[name,name]));
      if(info.pages){
        $(key+'-first').value='1';$(key+'-last').value=String(Math.min(info.pages,100));$(key+'-lastRow').value='';
      }
      updateSource(key);say('Select the '+key+' table, then preview it.');
    }catch(error){if(active())$(key+'-status').textContent=file.name+' · '+error.message;throw error;}
  });
}
function extract(key){
  if(!state[key].info||busy)return;
  state[key].table=null;clearRun();updateSource(key);
  const settings=Object.fromEntries(['header','sheet','first','last','lastRow','gap'].map(name=>[name,$(key+'-'+name).value]));
  settings.delimiter={comma:',',semi:';',tab:'\t'}[$(key+'-delimiter').value];
  task('Extracting the '+key+' table…',async active=>{
    try{
      const table=await send('extract',{side:key,options:settings});
      if(!active())return;
      state[key].table=table;
      const saved=prefs[key]?.columns;
      for(const [name] of columns){
        const initial=saved?.[name]??table.headers.findIndex(value=>guesses[name]?.test(value.trim().toLowerCase()));
        options($(key+'-'+name),[[-1,'Do not use this column'],...table.headers.map((value,i)=>[i,(i+1)+' · '+(clip(value,90)||'Unnamed column')])],initial);
      }
      if(!saved&&$(key+'-amount').value==='-1'&&$(key+'-debit').value!=='-1'&&$(key+'-credit').value!=='-1')$(key+'-amountMode').value='split';
      updateSource(key);say('Preview ready. Check the rows and column mapping.');
    }catch(error){if(active())$(key+'-status').textContent=state[key].file.name+' · '+error.message;throw error;}
  });
}
function updateSource(key){
  const {file,info,table}=state[key];
  $(key+'-options').hidden=!info;
  $(key+'-sheet-wrap').hidden=info?.type!=='xlsx';
  $(key+'-csv-wrap').hidden=info?.type!=='csv';
  $(key+'-pdf-wrap').hidden=info?.type!=='pdf';
  $(key+'-hint').textContent=info?.type==='pdf'?'PDF has '+info.pages+' pages. Select the repeated table pages and their shared header row.':'Header row counts from the first nonblank CSV record or first used worksheet row.';
  $(key+'-status').textContent=!file?'No file selected.':file.name+' · '+(info?.type||file.name.split('.').at(-1)).toUpperCase()+' · '+(file.size/1024).toFixed(1)+' KiB'+(table?' · '+table.rows+' data rows':'');
  const box=$(key+'-preview');box.replaceChildren();
  if(table){
    const wrap=node('div',undefined,'rec-scroll'),t=node('table');
    wrap.tabIndex=0;wrap.setAttribute('aria-label',key+' file preview');
    const head=t.createTHead().insertRow();
    for(const value of ['Source',...table.headers]){const th=node('th',clip(value)||'Unnamed');th.scope='col';head.append(th);}
    const body=t.createTBody();
    for(const row of table.preview){
      const line=body.insertRow();
      for(const value of [row.source,...table.headers.map((_,i)=>original(row.cells[i]))])line.insertCell().textContent=clip(value);
    }
    wrap.append(t);
    box.append(node('p','First '+table.preview.length+' of '+table.rows+' rows'+(table.excluded?' · '+table.excluded+' lines outside the selected table':'')),wrap);
  }
  updateMapping(key);
}
function mapping(key){
  const value=name=>$(key+'-'+name).value;
  return {...Object.fromEntries(columns.map(([name])=>[name,Number(value(name))])),
    amountMode:value('amountMode'),decimal:value('decimal'),thousands:value('thousands')==='apostrophe'?"'":value('thousands'),
    sign:Number(value('sign')),currencyStyle:value('currencyStyle'),dateOrder:value('dateOrder'),supplierValue:value('supplierValue')};
}
function updateMapping(key){
  const map=mapping(key),split=map.amountMode==='split';
  $(key+'-amount').parentElement.hidden=split;
  for(const name of ['debit','credit'])$(key+'-'+name).parentElement.hidden=!split;
  $(key+'-supplier-wrap').hidden=map.supplier<0;
  const target=$(key+'-signed-preview'),table=state[key].table;
  const text=split?(map.sign===1?'Signed amount = debit − credit. ':'Signed amount = credit − debit. '):
    (map.sign===1?'Signed amount = mapped amount. ':'Signed amount = mapped amount with its sign reversed. ');
  if(!table||(split?(map.debit<0||map.credit<0):map.amount<0)){target.textContent=text+'Select amount columns to preview.';return;}
  const currency=$('currency').value,digits=currencies[currency];
  const config={currency,scope:'export',maps:{[key]:{...map,date:-1,type:-1,supplier:-1}}};
  const values=table.preview.slice(0,3).map((row,i)=>{
    const record=normalizeRow(row,key,i,config,{digits});
    return record.disposition==='Invalid'?record.reason:money(record.amount,currency,digits);
  });
  target.textContent=text+'First rows: '+values.join(' · ');
}
function savePrefs(){
  if(!$('remember').checked)return;
  const next={};
  for(const [key] of sides){
    const value=name=>$(key+'-'+name).value;
    next[key]=Object.fromEntries(preferenceFields.map(name=>[name,value(name)]));
    const header=Number(value('header'));
    next[key].header=Number.isInteger(header)&&header>=1&&header<=100?header:1;
    next[key].columns=Object.fromEntries(columns.map(([name])=>[name,Number(value(name))]));
  }
  try{localStorage.setItem(prefKey,JSON.stringify(next));prefs=next;}catch{}
}
$('remember').onchange=()=>{
  if($('remember').checked){if(state.statement.table&&state.ledger.table)savePrefs();}
  else{try{localStorage.removeItem(prefKey);}catch{}prefs={};}
};
for(const id of ['supplier','currency','mode','basis','start','cutoff','scope']){
  $(id).oninput=()=>{
    $('compatible').checked=false;clearRun();
    $('period-start').hidden=$('mode').value!=='period';
    if($('mode').value==='open')$('scope').value='export';
    $('scope').options[1].disabled=$('mode').value==='open';
    if(id==='currency')for(const [key] of sides)updateMapping(key);
  };
}
$('scope').options[1].disabled=true;
$('compatible').onchange=clearRun;
function money(amount,currency=run?.config.currency,digits=run?.digits){
  if(amount==null)return '—';
  return new Intl.NumberFormat('en-US',{style:'currency',currency,minimumFractionDigits:digits,maximumFractionDigits:digits}).format(amount/10**digits);
}
$('run').onclick=()=>{
  const config=Object.fromEntries(['supplier','currency','mode','basis','start','cutoff','scope'].map(id=>[id,$(id).value.trim()]));
  config.compatible=$('compatible').checked;
  config.maps=Object.fromEntries(sides.map(([key])=>[key,mapping(key)]));
  clearRun();
  task('Reconciling records…',async active=>{
    const outcome=await send('reconcile',{config});
    if(!active())return;
    run=outcome;review=reviewIndex(run);savePrefs();$('filter').value='exceptions';$('results').hidden=false;
    $('result-scope').textContent=config.supplier+' · '+config.currency+' · '+(config.mode==='period'?config.start+' to ':'As of ')+config.cutoff;
    render();handoff.begin(run);say('Reconciliation complete. Review exceptions before exporting.');$('result-heading').focus();
  });
};
controls();

function suggestionStatus(item){
  if(pairs.some(pair=>pair.suggestionId===item.id))return 'Confirmed';
  if(review.actions.get(item.id)?.status==='Dismissed')return 'Dismissed';
  if(review.occupied.has(item.statementId)||item.candidateIds.every(id=>review.occupied.has(id)))return 'Unavailable';
  return 'Unresolved';
}
function resultItems(){
  const auto=run.result.map(group=>({...group,status:review.status(group),kind:'auto'}));
  const suggested=run.suggestions.map(group=>({...group,statementIds:[group.statementId],ledgerIds:group.candidateIds,
    category:'Suggested match',status:suggestionStatus(group),kind:'suggestion'}));
  const sources=run.records.filter(row=>['Invalid','Out of scope'].includes(row.disposition)).map(row=>({
    id:row.id,category:row.disposition,reason:row.reason,statementIds:row.side==='statement'?[row.id]:[],
    ledgerIds:row.side==='ledger'?[row.id]:[],evidence:'—',status:row.disposition==='Invalid'?'Unresolved':'Excluded',kind:'source'
  }));
  const manual=pairs.map((pair,i)=>({id:'M'+(i+1),category:'Manually confirmed',reason:'Manually confirmed pair.',
    statementIds:[pair.statementId],ledgerIds:[pair.ledgerId],evidence:'Manually confirmed',status:'Confirmed',kind:'pair',pair,
    difference:review.rows.get(pair.statementId).amount-review.rows.get(pair.ledgerId).amount}));
  return [...auto,...suggested,...sources,...manual];
}
function card(label,value){
  const item=node('div');
  item.append(node('strong',String(value)),node('span',label));
  return item;
}
function resultRows(ids){return ids.map(id=>review.rows.get(id));}
function render(){
  if(!run)return;
  review=reviewIndex(run,decisions,pairs);
  const {sources,counts,unresolved}=summarize(run,review);
  const a=sources.statement,b=sources.ledger;
  $('summary-cards').replaceChildren(...[
    ['Statement rows',a.rows],['Ledger rows',b.rows],['Exact matches',counts.Matched||0],['Amount mismatches',counts['Amount mismatch']||0],
    ['Missing in ledger',counts['Missing in ledger']||0],['Missing on statement',counts['Missing on statement']||0],
    ['Duplicate / credit review',(counts['Duplicate review']||0)+(counts['Credit review']||0)],
    ['Suggested groups',run.suggestions.length],['Manually confirmed',pairs.length],['Unresolved groups / invalid rows',unresolved],
    ['Invalid source rows',a.invalid+b.invalid],['Scope exclusions',a.excluded+b.excluded],
    ['Lines outside selected tables',state.statement.table.excluded+state.ledger.table.excluded],
    ['Statement in-scope total',money(a.total)],['Ledger in-scope total',money(b.total)]
  ].map(([label,value])=>card(label,value)));
  const filter=$('filter').value,query=normalize($('query').value);
  const items=resultItems().filter(item=>{
    const show=filter==='exceptions'?!['Matched','Manually confirmed','Out of scope'].includes(item.category):item.category===filter;
    return show&&(!query||[...item.statementIds,...item.ledgerIds].some(id=>review.rows.get(id).key.includes(query)));
  });
  const pages=Math.max(1,Math.ceil(items.length/30));
  page=Math.min(page,pages-1);
  const body=$('rows');body.replaceChildren();
  const summarizeSide=(records,field)=>records.length===0?'—':records.length>1?records.length+' rows':clip(records[0][field])||'—';
  for(const item of items.slice(page*30,(page+1)*30)){
    const left=resultRows(item.statementIds),right=resultRows(item.ledgerIds);
    const reference=[summarizeSide(left,'reference'),summarizeSide(right,'reference')].filter(value=>value!=='—');
    const row=body.insertRow();
    for(const value of [item.category,[...new Set(reference)].join(' / ')||'—',summarizeSide(left,'originalAmount'),
      summarizeSide(right,'originalAmount'),money(item.difference),summarizeSide(left,'source'),summarizeSide(right,'source'),item.evidence,item.status])
      row.insertCell().textContent=value;
    const button=node('button','Open','rec-secondary');button.type='button';button.onclick=()=>{if(!busy)openReview(item);};
    row.insertCell().append(button);
  }
  if(!items.length){const td=body.insertRow().insertCell();td.colSpan=10;td.textContent='No records match this view.';}
  $('pagination').textContent=items.length+' group(s) · Page '+(page+1)+' of '+pages;
  $('prev').disabled=page===0;$('next').disabled=page>=pages-1;
}
$('filter').onchange=()=>{page=0;render();};
$('query').oninput=()=>{page=0;render();};
$('prev').onclick=()=>{if(page>0){page--;render();}};
$('next').onclick=()=>{page++;render();};

function recordCard(row){
  const card=node('div',undefined,'rec-record');
  card.append(node('strong',row.reference||'Missing reference'));
  for(const [name,value] of [['Source',row.source],['Original date',row.originalDate],['Original amount',row.originalAmount],
    ['Signed amount',money(row.amount)],['Type',row.type],['Reason',row.reason]]){
    if(value&&value!=='—')card.append(node('p',name+' · '+value));
  }
  return card;
}
function pairPicker(side,records){
  const block=node('div');
  const name=side==='statement'?'Statement':'Ledger';
  const search=node('input');search.type='search';search.autocomplete='off';search.maxLength=120;
  const label=node('label',name+' search');label.append(search);block.append(label);
  const select=node('select');select.id='pair-'+side;
  const choice=node('label','Choose '+name.toLowerCase()+' record');choice.append(select);block.append(choice);
  const detail=node('div');block.append(detail);
  const refresh=()=>{
    const term=normalize(search.value);
    const list=records.filter(row=>!term||row.key.includes(term)||normalize(row.source).includes(term)||normalize(row.id)===term);
    options(select,[['','Choose a record'],...list.slice(0,80).map(row=>[row.id,clip(row.reference||'(no reference)',58)+' · '+clip(row.source,50)+' · '+money(row.amount)])],
      list.length===1?list[0].id:undefined);
    select.onchange();
  };
  select.onchange=()=>{
    const row=review.rows.get(select.value);
    detail.replaceChildren(...(row?[recordCard(row)]:[]));
    updateConfirm();
  };
  search.oninput=refresh;
  return {block,refresh};
}
function updateConfirm(){
  $('confirm-pair').disabled=!$('pair-statement')?.value||!$('pair-ledger')?.value;
}
function openReview(item){
  selected=item;
  const dialog=$('review-dialog');
  $('review-heading').textContent=item.category;
  $('review-reason').textContent=item.reason+(item.count>item.ledgerIds?.length?' Showing '+item.ledgerIds.length+' of '+item.count+' candidates.':'');
  $('review-status').textContent='';
  const existing=review.actions.get(item.id);
  $('review-note').value=existing?.note||item.pair?.note||'';
  const canDecide=item.kind==='suggestion'||item.kind==='auto'&&item.category!=='Matched';
  $('leave-open').hidden=$('dismiss-review').hidden=!canDecide;
  const eligible=item.kind==='manual'?{
    statement:run.records.filter(row=>row.side==='statement'&&row.resultId&&!review.occupied.has(row.id)),
    ledger:run.records.filter(row=>row.side==='ledger'&&row.resultId&&!review.occupied.has(row.id))
  }:{
    statement:resultRows(item.statementIds).filter(row=>row.resultId&&!review.occupied.has(row.id)),
    ledger:resultRows(item.ledgerIds).filter(row=>row.resultId&&!review.occupied.has(row.id))
  };
  const canPair=eligible.statement.length>0&&eligible.ledger.length>0&&item.status!=='Dismissed';
  $('confirm-pair').hidden=!canPair;
  $('review-note-label').hidden=!(canDecide||canPair||item.pair?.note);
  $('review-note').readOnly=!canDecide&&!canPair;
  $('review-records').replaceChildren();
  $('pair-fields').replaceChildren();
  if(!canPair&&item.kind!=='manual'){
    for(const [ids,title] of [[item.statementIds,'Statement'],[item.ledgerIds,'Ledger']]){
      const section=node('section');section.append(node('h3',title));
      for(const row of resultRows(ids.slice(0,20)))section.append(recordCard(row));
      if(!ids.length)section.append(node('p','No counterpart.'));
      if(ids.length>20)section.append(node('p','Showing 20 of '+ids.length+' rows. The workbook includes all rows.'));
      $('review-records').append(section);
    }
  }else if(canPair){
    const pickers=['statement','ledger'].map(side=>pairPicker(side,eligible[side]));
    $('pair-fields').append(...pickers.map(picker=>picker.block));
    pickers.forEach(picker=>picker.refresh());
  }else $('review-reason').textContent='No unpaired records are available on both sides.';
  if(!dialog.open)dialog.showModal();
}
$('manual').onclick=()=>openReview({id:'manual',kind:'manual',category:'Confirm a manual pair',reason:'Choose one unpaired record from each side. Check the original references and amounts before confirming.'});
$('close-review').onclick=()=>$('review-dialog').close();
$('review-dialog').addEventListener('close',()=>{
  $('review-note').value='';$('review-records').replaceChildren();$('pair-fields').replaceChildren();selected=null;
});
function saveDecision(status){
  if(!selected||!run)return;
  const note=$('review-note').value.trim();
  if(status==='Dismissed'&&!note){$('review-status').textContent='Enter a reason before dismissing this item.';return;}
  const next=[...decisions.filter(item=>item.id!==selected.id),{id:selected.id,status,note}];
  try{
    reviewIndex(run,next,pairs);decisions=next;
    $('review-dialog').close();render();say('Review decision saved for this session.');
  }catch(error){$('review-status').textContent=error.message;}
}
$('leave-open').onclick=()=>saveDecision('Unresolved');
$('dismiss-review').onclick=()=>saveDecision('Dismissed');
$('confirm-pair').onclick=()=>{
  if(!run||!selected)return;
  const statementId=$('pair-statement')?.value,ledgerId=$('pair-ledger')?.value;
  const next=[...pairs,{statementId,ledgerId,note:$('review-note').value.trim(),suggestionId:selected.kind==='suggestion'?selected.id:undefined}];
  try{
    reviewIndex(run,decisions,next);pairs=next;
    $('review-dialog').close();render();say('Pair confirmed. The original automated results were retained.');
  }catch(error){$('review-status').textContent=error.message;}
};

$('export').onclick=()=>{
  if(!run)return;
  task('Preparing the Excel report…',async active=>{
    const buffer=await send('export',{decisions,pairs,actionRows:handoff.workbookRows()});
    if(!active())return;
    download(buffer,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','filefreely-reconciliation.xlsx');
    say('Excel report downloaded.');
  });
};
$('print').onclick=()=>{
  if(!run)return;
  const target=$('print-report'),summary=summarize(run,review),{statement,ledger}=summary.sources,config=run.config;
  const totalExceptions=run.result.filter(group=>group.category!=='Matched').length+statement.invalid+ledger.invalid;
  target.replaceChildren(node('h1','FileFreely Reconcile · Summary'),
    node('p',config.supplier+' · '+config.currency+' · '+(config.mode==='period'?config.start+' to ':'As of ')+config.cutoff),
    node('p',(config.mode==='period'?'Period activity':'Open items')+' · '+(config.basis==='balance'?'Outstanding balance':'Original invoice amount')),
    node('p','Statement: '+statement.rows+' rows, '+money(statement.total)+' in scope. Ledger: '+ledger.rows+' rows, '+money(ledger.total)+' in scope.'),
    node('p','Signed difference: '+money(statement.total-ledger.total)+'.'),
    node('p','Exact matches: '+(summary.counts.Matched||0)+'. Manually confirmed pairs: '+pairs.length+'. Automated exceptions and invalid rows: '+totalExceptions+'.'),
    node('p','Unresolved groups and invalid rows: '+summary.unresolved+'. Scope exclusions: '+(statement.excluded+ledger.excluded)+'.'));
  const notes=[...decisions.filter(item=>item.note).map(item=>item.id+' · '+item.status+' · '+item.note),
    ...pairs.filter(pair=>pair.note).map(pair=>pair.statementId+' + '+pair.ledgerId+' · '+pair.note)];
  if(notes.length){
    const list=node('ul');for(const note of notes)list.append(node('li',note));
    target.append(node('h2','Reviewer notes'),list);
  }
  window.print();
};
