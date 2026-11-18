import {normalize} from './engine.mjs';
import {actionStatuses,approveRequest,buildCarryForward,createRegister,maxCarryBytes,messageDefaults,parseCarryForward,
  registerRows,requestCategories,requestText,supplierMessage} from './handoff.mjs';

export function connectHandoff({$,node,download,money}){
  let run=null,carry=null,items=[],activeAction=null,activeRequest=null,page=0;
  let busy=false,dirty=false,loading=false,revision=0,scopeError='';
  const requests=new Map();
  const wording=['subject','greeting','intro','closing'];
  const defaults={
    'Missing in ledger':'Missing invoice','Amount mismatch':'Invoice amount clarification',
    'Duplicate review':'Duplicate invoice clarification'
  };
  const say=(text,error=false)=>{
    $('handoff-status').textContent=text;
    $('handoff-status').classList.toggle('rec-error',error);
  };
  const addOptions=(id,choices)=>$(id).append(...choices.map(value=>new Option(value,value)));
  addOptions('action-filter',actionStatuses);
  addOptions('action-status',actionStatuses);
  addOptions('request-category',Object.keys(requestCategories));
  const closed=item=>['Resolved','Dismissed'].includes(item.status);
  const canShare=item=>!closed(item)&&item.category!=='Invalid source row'&&Boolean(item.reference)&&item.reference.length<=256;

  function controls(){
    $('carry-file').disabled=busy||dirty||loading;
    $('carry-remove').disabled=busy||dirty&&!scopeError||loading||!carry;
    $('carry-download').disabled=busy||loading||!run||Boolean(scopeError)||!items.some(item=>!closed(item));
  }
  function describeCarry(){
    $('carry-status').textContent=scopeError||(carry?
      'Loaded '+carry.items.length+' historical item(s) from '+carry.cutoff+'.'+
        (dirty?' This file is locked until you start another reconciliation.':''):'No carry-forward file selected.');
    $('carry-status').classList.toggle('rec-error',Boolean(scopeError));
  }
  function showCarryError(error){
    $('carry-status').textContent=error.message;
    $('carry-status').classList.add('rec-error');
  }
  function setBusy(value){busy=value;controls();}
  function reset(clearCarry=false){
    revision++;
    run=null;items=[];requests.clear();activeAction=activeRequest=null;page=0;dirty=loading=false;scopeError='';
    if(clearCarry)carry=null;
    for(const id of ['action-dialog','request-dialog'])if($(id).open)$(id).close();
    for(const id of ['action-query','action-filter','action-category','action-reviewer','action-note','action-resolution',
      'request-explanation','message-preview'])$(id).value='';
    for(const field of wording)$('message-'+field).value=messageDefaults[field];
    for(const id of ['action-summary','action-evidence','request-reference','request-statement-details','request-status','action-count'])
      $(id).textContent='';
    $('request-statement').replaceChildren();
    for(const id of ['request-date','request-amount','request-approve','message-confirm'])$(id).checked=false;
    $('action-rows').replaceChildren();$('supplier-requests').replaceChildren();
    for(const id of ['handoff','handoff-export','message-editing','message-final'])$(id).hidden=true;
    $('message-editing').open=false;$('carry-file').value='';
    say('');describeCarry();controls();
  }
  function showRegister(){
    const filter=$('action-filter').value,category=$('action-category').value,query=normalize($('action-query').value);
    const filtered=items.filter(item=>(!filter||item.status===filter)&&(!category||item.category===category)&&
      (!query||item.evidence.some(row=>normalize(row.reference).includes(query))));
    const count=Math.max(1,Math.ceil(filtered.length/20));
    page=Math.min(page,count-1);
    const body=$('action-rows');body.replaceChildren();
    for(const item of filtered.slice(page*20,(page+1)*20)){
      const row=body.insertRow();
      for(const value of [item.reference||'No reference',item.category,item.status,item.comparison?.message||'Current statement'])
        row.insertCell().textContent=value;
      const cell=row.insertCell();
      const edit=node('button','Edit action','rec-secondary');
      edit.type='button';edit.onclick=()=>{if(!busy&&!loading)openAction(item);};
      cell.append(edit);
      if(canShare(item)){
        const share=node('button',requests.has(item.id)?'Edit request':'Prepare request','rec-secondary');
        share.type='button';share.onclick=()=>{if(!busy&&!loading)openRequest(item);};
        cell.append(share);
      }
    }
    if(!filtered.length){
      const cell=body.insertRow().insertCell();
      cell.colSpan=5;cell.textContent='No actions match this view.';
    }
    $('action-count').textContent=filtered.length+' action(s) · Page '+(page+1)+' of '+count;
    $('action-prev').disabled=page===0;$('action-next').disabled=page>=count-1;
  }
  function populateRegister(){
    $('action-category').replaceChildren(new Option('All categories',''));
    addOptions('action-category',[...new Set(items.map(item=>item.category))]);
    page=0;showRegister();controls();
  }
  function begin(next){
    run=next;
    try{items=createRegister(run,carry);}
    catch(error){scopeError=error.message;items=createRegister(run);}
    $('handoff').hidden=$('handoff-export').hidden=false;
    describeCarry();populateRegister();showMessage();
    if(scopeError)say(scopeError+' Open Configure to remove or replace the incompatible file.',true);
  }
  function markDirty(){
    dirty=true;describeCarry();controls();
  }
  $('carry-file').onchange=async event=>{
    const [file]=event.target.files;event.target.value='';
    if(!file||busy||dirty||loading)return;
    const pending=revision;loading=true;controls();
    try{
      if(file.size>maxCarryBytes)throw Error('Carry-forward files must be 12 MB or smaller.');
      const next=parseCarryForward(await file.text());
      if(pending!==revision)return;
      if(run)items=createRegister(run,next);
      carry=next;scopeError='';describeCarry();
      if(run){populateRegister();say('Historical actions are ready for review.');}
    }catch(error){if(pending===revision)showCarryError(error);}
    finally{if(pending===revision){loading=false;controls();}}
  };
  $('carry-remove').onclick=()=>{
    if(busy||dirty&&!scopeError||loading)return;
    const incompatible=Boolean(scopeError);
    carry=null;scopeError='';describeCarry();
    if(run){
      if(!incompatible){items=createRegister(run);populateRegister();}
      say('Carry-forward file removed.');
    }
    controls();
  };
  $('carry-download').onclick=()=>{
    if(!run||busy||loading||scopeError)return;
    try{
      download(buildCarryForward(run.config,items),'application/json','filefreely-carry-forward-'+run.config.cutoff+'.json');
      say('Unresolved actions downloaded. Keep the JSON private and import it for the next statement.');
    }catch(error){say(error.message,true);}
  };
  $('action-prev').onclick=()=>{if(page){page--;showRegister();}};
  $('action-next').onclick=()=>{page++;showRegister();};
  for(const id of ['action-category','action-filter','action-query'])$(id).oninput=()=>{page=0;showRegister();};

  function openAction(item){
    activeAction=item;
    $('action-summary').textContent=(item.reference||'No reference')+' · '+item.category+' · '+item.reason;
    const current=item.originals.length?item.originals:item.comparison?.rows||[];
    const lines=current.slice(0,12).map(row=>row.side+' · '+row.source+' · '+row.originalAmount);
    if(current.length>12)lines.push('See the workbook for all source rows.');
    if(item.history.length){
      lines.unshift(item.comparison.message,'Previous status: '+item.previousStatus,
        'History: '+item.history.map(entry=>entry.cutoff+' · '+entry.status).join(' / '));
      lines.push(...item.evidence.slice(0,12).map(row=>
        'Previous '+row.side+' · '+row.reference+' · '+(row.date||'No date')+' · '+money(row.amount)));
      if(item.evidence.length>12)lines.push('Additional historical evidence is in the workbook.');
    }
    $('action-evidence').textContent=lines.join('\n');
    $('action-status').value=item.status;$('action-reviewer').value=item.reviewer||'';
    $('action-note').value=item.note;$('action-resolution').value=item.resolution;
    $('action-dialog').showModal();
  }
  $('action-close').onclick=()=>$('action-dialog').close();
  $('action-dialog').addEventListener('close',()=>{
    activeAction=null;
    for(const id of ['action-reviewer','action-note','action-resolution'])$(id).value='';
    $('action-summary').textContent=$('action-evidence').textContent='';
  });
  $('action-save').onclick=()=>{
    if(!activeAction||!run||busy)return;
    Object.assign(activeAction,{status:$('action-status').value,reviewer:$('action-reviewer').value.trim(),
      note:$('action-note').value.trim(),resolution:$('action-resolution').value.trim()});
    const removed=closed(activeAction)&&requests.delete(activeAction.id);
    $('action-dialog').close();
    markDirty();showRegister();
    if(removed)showMessage();
    say(removed?'Internal action saved. The closed item was removed from the supplier preview.':'Internal action saved.');
  };

  function updateStatementDetails(){
    const row=activeRequest?.item.originals.find(row=>row.id===$('request-statement').value&&row.side==='statement');
    $('request-statement-details').textContent=row?'Selected statement row · '+(row.date?.iso||'No date')+' · '+money(row.amount):'No statement date or amount selected.';
    $('request-date').disabled=!row?.date;
    $('request-amount').disabled=!Number.isSafeInteger(row?.amount);
    if($('request-date').disabled)$('request-date').checked=false;
    if($('request-amount').disabled)$('request-amount').checked=false;
  }
  function requireItemApproval(){
    $('request-approve').checked=false;$('request-save').disabled=true;$('request-status').textContent='';
  }
  function openRequest(item){
    const existing=requests.get(item.id);
    const category=existing?.publicRequest.category||defaults[item.category]||
      (item.category==='Credit review'?(item.evidence.some(row=>row.side==='statement')&&!item.evidence.some(row=>row.side==='ledger')?
        'Missing credit note':'Credit allocation clarification'):'Other query');
    activeRequest={item};
    $('request-reference').textContent='Reference to share · '+item.reference;
    $('request-category').value=category;
    $('request-explanation').value=existing?.publicRequest.explanation||requestCategories[category];
    const statement=item.originals.filter(row=>row.side==='statement'&&row.disposition!=='Invalid');
    $('request-statement').replaceChildren(new Option('Reference only',''),...statement.map(row=>
      new Option(row.id+' · '+(row.date?.iso||'No date')+' · '+money(row.amount),row.id)));
    $('request-statement-label').hidden=!statement.length;
    $('request-statement').value=existing?.statementId||'';
    $('request-date').checked=Boolean(existing?.publicRequest.date);
    $('request-amount').checked=Boolean(existing?.publicRequest.amount);
    updateStatementDetails();requireItemApproval();
    $('request-dialog').showModal();
  }
  $('request-close').onclick=()=>$('request-dialog').close();
  $('request-dialog').addEventListener('close',()=>{
    activeRequest=null;$('request-explanation').value='';
    $('request-reference').textContent=$('request-statement-details').textContent=$('request-status').textContent='';
    $('request-statement').replaceChildren();
  });
  $('request-category').onchange=()=>{
    $('request-explanation').value=requestCategories[$('request-category').value];
    requireItemApproval();
  };
  $('request-statement').onchange=()=>{
    $('request-date').checked=$('request-amount').checked=false;
    updateStatementDetails();requireItemApproval();
  };
  for(const id of ['request-date','request-amount','request-explanation'])$(id).oninput=requireItemApproval;
  $('request-approve').onchange=()=>{$('request-save').disabled=!$('request-approve').checked;};
  $('request-save').onclick=()=>{
    if(!activeRequest||!run||busy)return;
    const {item}=activeRequest;
    const choice={category:$('request-category').value,explanation:$('request-explanation').value,statementId:$('request-statement').value,
      approved:$('request-approve').checked,includeDate:$('request-date').checked,includeAmount:$('request-amount').checked};
    try{
      requests.set(item.id,{publicRequest:approveRequest(item,choice,run.config.currency),statementId:choice.statementId});
      $('request-dialog').close();
      markDirty();showRegister();showMessage();say('Request approved. Review the final supplier preview before copying.');
    }catch(error){$('request-status').textContent=error.message;}
  };

  function syncCopyButtons(){
    for(const button of [$('message-copy'),...$('supplier-requests').querySelectorAll('[data-copy-request]')])
      button.disabled=!$('message-confirm').checked;
  }
  function updatePreview(){
    const config=run?.config;
    const period=config?.mode==='period'?config.start+' to '+config.cutoff:'the period ending '+config?.cutoff;
    const edits=Object.fromEntries(wording.map(field=>[field,$('message-'+field).value]));
    $('message-preview').value=supplierMessage({supplier:config?.supplier,period},
      [...requests.values()].map(entry=>entry.publicRequest),edits);
    $('message-confirm').checked=false;syncCopyButtons();
  }
  function showMessage(){
    const list=$('supplier-requests');list.replaceChildren();
    if(!requests.size)list.append(node('p','No supplier requests approved.'));
    for(const [id,{publicRequest}] of requests){
      const item=node('div',undefined,'rec-record');
      const copy=node('button','Copy individual request','rec-secondary');
      copy.type='button';copy.dataset.copyRequest='';
      copy.onclick=()=>copyText(requestText(publicRequest));
      const remove=node('button','Remove request','rec-secondary');
      remove.type='button';remove.onclick=()=>{
        requests.delete(id);showRegister();showMessage();say('Request removed from the supplier preview.');
      };
      const buttons=node('div',undefined,'rec-actions');buttons.append(copy,remove);
      item.append(node('p',requestText(publicRequest)),buttons);list.append(item);
    }
    $('message-editing').hidden=$('message-final').hidden=!requests.size;
    updatePreview();
  }
  async function copyText(text){
    if(!$('message-confirm').checked||!text)return;
    try{await navigator.clipboard.writeText(text);say('Approved supplier text copied.');}
    catch{
      const preview=$('message-preview'),index=preview.value.indexOf(text);
      if(!$('message-confirm').checked||index<0){
        say('The preview changed. Review and approve the current text before copying.',true);return;
      }
      preview.focus();preview.setSelectionRange(index,index+text.length);
      say('Automatic copying is unavailable. Use your browser or keyboard to copy the selected text.');
    }
  }
  for(const field of wording)$('message-'+field).oninput=updatePreview;
  $('message-confirm').onchange=syncCopyButtons;
  $('message-copy').onclick=()=>copyText($('message-preview').value);
  return {begin,reset,setBusy,workbookRows:()=>registerRows(items)};
}
