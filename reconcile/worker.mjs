import {openFile,extractTable} from './parser.mjs';
import {original,reconcile,reviewIndex,summarize} from './engine.mjs';
import {buildWorkbook} from './report.mjs';
const files={}, tables={};
let result=null;
function loadXlsx(){
  if(!globalThis.XLSX)self.importScripts('./vendor/xlsx-0.20.3.min.js');
  if(globalThis.XLSX?.version!=='0.20.3')throw Error('The bundled Excel library version does not match.');
}

export async function runCommand({id,action,side,type,buffer,options,config,decisions,pairs,actionRows}){
  const progress=(message,current=null,total=null)=>self.postMessage({id,progress:{message,current,total}});
  const reply=(data,transfer=[])=>self.postMessage({id,data},transfer);
  if(side&&!['statement','ledger'].includes(side))throw Error('Invalid document side.');
  if(action==='load'||action==='remove'){
    if(files[side]?.task)await files[side].task.destroy().catch(()=>{});
    delete files[side];delete tables[side];result=null;
    if(action==='remove'){reply(null);return;}
    if(side==='ledger'&&type==='pdf')throw Error('Ledger files must be CSV or XLSX.');
    if(type==='xlsx')loadXlsx();
    const file=await openFile(new Uint8Array(buffer),type,progress);
    files[side]=file;
    reply({type,pages:file.pages,sheets:file.sheets});return;
  }
  if(action==='extract'){
    delete tables[side];result=null;
    if(!files[side])throw Error('Choose a file first.');
    const table=await extractTable(files[side],options,progress);
    const width=table.headers.length;
    const all=[...table.rows,...table.excluded];
    if(all.reduce((n,row)=>n+Math.max(width,row.cells.length),0)>120000||
       all.reduce((n,row)=>n+row.cells.reduce((x,cell)=>x+original(cell).length,0),0)>3e6)
      throw Error('The selected table is too large. Use a smaller export.');
    tables[side]=table;
    reply({headers:table.headers,preview:table.rows.slice(0,8),
      rows:table.rows.length,excluded:table.excluded.length});return;
  }
  if(action==='reconcile'){
    if(!tables.statement||!tables.ledger)throw Error('Preview both tables before reconciling.');
    result=reconcile(tables,config,(current,total)=>progress('Processing '+current+' of '+total+' records…',current,total));
    const summary=summarize(result,reviewIndex(result));
    // The interface only needs mapped values. Full source rows stay in the worker.
    reply({...result,summary,records:result.records.map(({values,...record})=>record)});return;
  }
  if(action==='export'){
    if(!result)throw Error('Run a reconciliation first.');
    loadXlsx();
    progress('Preparing the reconciliation and action register workbook…');
    const workbook=buildWorkbook(result,tables,decisions,pairs,globalThis.XLSX,actionRows);
    reply(workbook,[workbook]);return;
  }
  throw Error('Unknown operation.');
}
