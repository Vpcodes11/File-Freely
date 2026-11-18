import {original,normalize} from './engine.mjs';
export const MAX_FILE=25*1024*1024, MAX_ROWS=4000, MAX_COLUMNS=64;
const MAX_EXPANDED=48*1024*1024, MAX_ENTRY=16*1024*1024;
const noText='This PDF appears to contain scanned images rather than selectable text. OCR is not supported yet. Please use a digital PDF or export the statement to Excel/CSV.';
const utf8=new TextDecoder('utf-8',{fatal:true});

export function parseCSV(text, delimiter) {
  if(![',',';','\t'].includes(delimiter))throw Error('Choose a supported CSV delimiter.');
  const rows=[];
  let row=[],cell='',state=0,line=1,start=1;
  const pushCell=()=>{
    if(row.length>=MAX_COLUMNS)throw Error('CSV exceeds the 64-column limit.');
    if(cell.length>16000)throw Error('A CSV cell exceeds 16,000 characters.');
    row.push(cell);cell='';state=0;
  };
  const pushRow=()=>{
    pushCell();
    if(row.some(value=>value.trim())){
      if(rows.length>MAX_ROWS)throw Error('CSV exceeds the 4,000-row limit.');
      rows.push({cells:row,source:'CSV line '+start});
    }
    row=[];
  };
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(state===1){
      if(ch==='"'){
        if(text[i+1]==='"'){cell+='"';i++;}
        else state=2;
      }else{
        cell+=ch;
        if(ch==='\n'||ch==='\r'&&text[i+1]!=='\n')line++;
      }
    }else if(ch===delimiter)pushCell();
    else if(ch==='\r'||ch==='\n'){
      pushRow();
      if(ch==='\r'&&text[i+1]==='\n')i++;
      start=++line;
    }else if(ch==='"'&&!cell&&state===0)state=1;
    else{
      if(state===2||ch==='"')throw Error('Malformed CSV quoting near line '+line+'.');
      cell+=ch;
    }
    if(cell.length>16000)throw Error('A CSV cell exceeds 16,000 characters.');
  }
  if(state===1)throw Error('CSV has an unterminated quoted cell.');
  if(row.length||cell||state===2)pushRow();
  return rows;
}

// Verify both ZIP headers and the actual inflated byte count before handing a workbook to the XLSX reader.
export async function inspectZip(bytes){
  if(bytes.length<22)throw Error('Invalid XLSX ZIP archive.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const u16=at=>view.getUint16(at,true),u32=at=>view.getUint32(at,true);
  let end=bytes.length-22;
  while(end>=Math.max(0,bytes.length-65557)&&(u32(end)!==0x06054b50||end+22+u16(end+20)!==bytes.length))end--;
  if(end<0||end<bytes.length-65557||u32(end)!==0x06054b50)throw Error('Invalid XLSX ZIP directory.');
  const count=u16(end+10),size=u32(end+12),offset=u32(end+16);
  if(u16(end+4)||u16(end+6)||u16(end+8)!==count||!count||count>256||offset+size!==end)throw Error('Unsupported XLSX ZIP directory.');
  let at=offset,expanded=0;
  const names=new Set(), spans=[];
  for(let i=0;i<count;i++){
    if(at+46>end||u32(at)!==0x02014b50)throw Error('Malformed XLSX ZIP directory.');
    const flags=u16(at+8),method=u16(at+10),packed=u32(at+20),length=u32(at+24);
    const nameLength=u16(at+28),extra=u16(at+30),comment=u16(at+32),local=u32(at+42);
    const next=at+46+nameLength+extra+comment;
    if(next>end||local+30>offset||u32(local)!==0x04034b50||
       ![0,8].includes(method)||(flags&0x2041)||flags!==u16(local+6)||method!==u16(local+8))throw Error('Unsupported XLSX ZIP entry.');
    const localName=u16(local+26),data=local+30+localName+u16(local+28);
    const name=utf8.decode(bytes.subarray(at+46,at+46+nameLength));
    if(!name||name.includes('\\')||name.includes('\0')||name.startsWith('/')||name.split('/').includes('..')||names.has(name)||
       localName!==nameLength||data+packed>offset||utf8.decode(bytes.subarray(local+30,local+30+localName))!==name)
      throw Error('Unsafe or inconsistent XLSX ZIP entry.');
    if(/(?:vbaProject|externalLinks|embeddings|activeX)/i.test(name))throw Error('XLSX contains macros, embedded objects, or external workbook links. Export a values-only copy.');
    if(!(flags&8)&&(u32(local+18)!==packed||u32(local+22)!==length))throw Error('Inconsistent XLSX ZIP sizes.');
    names.add(name);spans.push([local,data+packed]);
    expanded+=length;
    if(length>MAX_ENTRY||expanded>MAX_EXPANDED)throw Error('XLSX exceeds the decompressed size limit.');
    if(method===0){
      if(packed!==length)throw Error('Invalid stored XLSX ZIP entry.');
    }else{
      const reader=new Blob([bytes.subarray(data,data+packed)]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      let seen=0;
      try{
        while(true){
          const chunk=await reader.read();
          if(chunk.done)break;
          seen+=chunk.value.byteLength;
          if(seen>length){await reader.cancel();throw Error('XLSX ZIP expands beyond its declared size.');}
        }
      }finally{reader.releaseLock();}
      if(seen!==length)throw Error('Invalid compressed XLSX ZIP entry.');
    }
    at=next;
  }
  spans.sort((a,b)=>a[0]-b[0]);
  if(at!==end||spans.some(([start],i)=>i&&start<spans[i-1][1])||!names.has('[Content_Types].xml')||!names.has('xl/workbook.xml'))
    throw Error('Invalid or overlapping XLSX ZIP entries.');
}

function textRuns(page,items){
  const viewport=page.getViewport({scale:1});
  const runs=[];
  for(const item of items){
    if(!item.str?.trim())continue;
    const [a,b,,,x,y]=item.transform;
    const [left,top]=viewport.convertToViewportPoint(x,y);
    const [right,bottom]=viewport.convertToViewportPoint(x+a,y+b);
    if(right-left<=Math.abs(bottom-top))throw Error('The selected PDF pages contain rotated or vertical text. Use a spreadsheet export or select different pages.');
    const width=Math.abs(item.width),height=Math.max(1,item.height||Math.hypot(a,b));
    if(![left,top,width,height].every(Number.isFinite))throw Error('The PDF contains invalid text positions.');
    runs.push({text:item.str.trim(),x:left,y:top,width,height});
  }
  return runs.sort((a,b)=>a.y-b.y||a.x-b.x);
}
function linesFromRuns(runs,gap){
  const lines=[];
  for(const run of runs){
    const last=lines.at(-1);
    if(last&&Math.abs(last.y-run.y)<=Math.min(3.5,Math.max(1.5,Math.min(last.height,run.height)*.24)))last.runs.push(run);
    else lines.push({y:run.y,height:run.height,runs:[run]});
  }
  return lines.map(line=>{
    const cells=[];
    let end=-Infinity;
    for(const run of line.runs.sort((a,b)=>a.x-b.x)){
      const threshold=gap==='tight'?Math.max(2.5,.34*run.height):gap==='wide'?Math.max(10,1.1*run.height):Math.max(5,.62*run.height);
      if(!cells.length||run.x-end>=threshold){cells.push({left:run.x,right:run.x+run.width,text:run.text});end=run.x+run.width;}
      else{
        const cell=cells.at(-1);
        cell.text+=(run.x-end>Math.max(.35,run.height*.08)?' ':'')+run.text;
        cell.right=end=Math.max(end,run.x+run.width);
      }
    }
    return cells;
  });
}
function align(line,header){
  if(line.length===header.length)return line.map(cell=>cell.text);
  if(line.length>header.length)throw Error('A PDF row has more columns than its header. Adjust column gaps or table boundaries.');
  const values=Array(header.length).fill('');
  let first=0;
  for(const [index,cell] of line.entries()){
    let best=first,distance=Infinity;
    for(let j=first;j<=header.length-line.length+index;j++){
      const delta=Math.min(Math.abs(header[j].left-cell.left),Math.abs(header[j].right-cell.right)+.5);
      if(delta<distance){best=j;distance=delta;}
    }
    values[best]=cell.text;first=best+1;
  }
  return values;
}
const integer=(value,min,max,label)=>{
  const n=Number(value);
  if(!Number.isInteger(n)||n<min||n>max)throw Error('Choose a valid '+label+'.');
  return n;
};

export async function openFile(bytes,type,onProgress){
  if(!bytes.length||bytes.length>MAX_FILE)throw Error('Choose a non-empty file up to 25 MiB.');
  if(type==='pdf'){
    if(!new TextDecoder().decode(bytes.subarray(0,1024)).includes('%PDF-'))throw Error('The file does not have a PDF header.');
    const pdfjs=await import('./vendor/legacy/build/pdf.min.mjs');
    if(pdfjs.version!=='6.5.438')throw Error('The bundled PDF reader version does not match.');
    pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/legacy/build/pdf.worker.min.mjs',import.meta.url).href;
    const task=pdfjs.getDocument({data:bytes,isEvalSupported:false,stopAtErrors:true,maxImageSize:16e6,
      cMapUrl:'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/cmaps/',cMapPacked:true,useWasm:false,isOffscreenCanvasSupported:false});
    try{
      const doc=await task.promise;
      return {type,task,doc,pages:doc.numPages};
    }catch(error){
      await task.destroy().catch(()=>{});
      if(error.name==='PasswordException')throw Error('This PDF is password-protected. Use an unlocked export.');
      throw Error('The PDF could not be read. Use a fresh digital export.');
    }
  }
  if(type==='csv'){
    if(bytes.includes(0)||bytes[0]===0x50&&bytes[1]===0x4b)throw Error('Use a UTF-8 CSV text export.');
    return {type,text:utf8.decode(bytes)};
  }
  if(type!=='xlsx')throw Error('Unsupported file type.');
  onProgress?.('Checking XLSX archive…');
  await inspectZip(bytes);
  const xlsx=globalThis.XLSX;
  if(xlsx?.version!=='0.20.3')throw Error('The bundled Excel reader version does not match.');
  const book=xlsx.read(bytes,{type:'array',cellDates:true,cellHTML:false,cellFormula:true,bookVBA:false,cellNF:true});
  if(!book.SheetNames.length||book.SheetNames.length>64)throw Error('Choose a workbook with 1–64 worksheets.');
  return {type,book,sheets:book.SheetNames};
}

function xlsxRows(file,options){
  const sheet=file.book.Sheets[options.sheet],xlsx=globalThis.XLSX;
  if(!sheet)throw Error('Choose a worksheet.');
  if(!sheet['!ref'])return [];
  const range=xlsx.utils.decode_range(sheet['!ref']);
  if(range.e.r-range.s.r>MAX_ROWS||range.e.c-range.s.c>=MAX_COLUMNS)throw Error('Worksheet exceeds 4,000 data rows or 64 columns. Use a smaller export.');
  const rows=[];
  for(let r=range.s.r;r<=range.e.r;r++){
    const cells=[];
    for(let c=range.s.c;c<=range.e.c;c++){
      const value=sheet[xlsx.utils.encode_cell({r,c})];
      if(!value){cells.push('');continue;}
      if(value.f!=null){
        const text='='+String(value.f);
        if(text.length>16000)throw Error('A worksheet cell exceeds 16,000 characters.');
        cells.push({text,formula:true});continue;
      }
      const text=String(value.w??value.v??'');
      if(text.length>16000)throw Error('A worksheet cell exceeds 16,000 characters.');
      cells.push({text,...(value.t==='n'?{number:value.v}:{}),...(value.t==='d'&&value.v instanceof Date&&Number.isFinite(value.v.getTime())?{date:value.v.toISOString().slice(0,10)}:{})});
    }
    rows.push({cells,source:options.sheet+' · row '+(r+1)});
  }
  return rows;
}
export async function extractTable(file,options,progress=()=>{}){
  if(file.type!=='pdf'){
    const rows=file.type==='csv'?parseCSV(file.text,options.delimiter):xlsxRows(file,options);
    const first=integer(options.header,1,rows.length,'header row')-1;
    const headers=rows[first].cells.map(original);
    if(headers.length<2||headers.length>MAX_COLUMNS)throw Error('Select a header with at least two columns. Check the CSV delimiter.');
    const data=rows.slice(first+1).filter(row=>row.cells.some(value=>original(value).trim()));
    const width=Math.max(headers.length,...data.map(row=>row.cells.length));
    while(headers.length<width)headers.push('');
    if(!data.length)throw Error('No records were found below the selected header.');
    if(data.length>MAX_ROWS)throw Error('Table exceeds 4,000 data rows.');
    return {headers,rows:data,excluded:rows.slice(0,first).filter(row=>row.cells.some(value=>original(value).trim())).map(row=>({...row,reason:'Before the selected header.'}))};
  }
  const {doc}=file;
  const first=integer(options.first||1,1,doc.numPages,'first PDF page');
  const last=integer(options.last||doc.numPages,first,doc.numPages,'last PDF page');
  if(last-first>=100)throw Error('Select up to 100 PDF pages.');
  const headerIndex=integer(options.header,1,100,'header row')-1;
  let headers,expected;
  const rows=[],excluded=[];
  let sourceCharacters=0, sourceCells=0;
  for(let i=first;i<=last;i++){
    progress('Extracting statement page '+i+' of '+last+'…');
    const page=await doc.getPage(i);
    let lines;
    try{
      const {items}=await page.getTextContent();
      if(items.length>20000)throw Error('A selected PDF page exceeds the text-fragment limit.');
      lines=linesFromRuns(textRuns(page,items),options.gap);
    }finally{page.cleanup();}
    if(!lines.length)throw Error(noText);
    const header=lines[headerIndex];
    if(!header||header.length<2||header.length>MAX_COLUMNS)throw Error('No usable header on PDF page '+i+'. Check the header row and column gap.');
    const keys=header.map(cell=>normalize(cell.text));
    if(!headers){headers=header.map(cell=>cell.text);expected=keys;}
    if(keys.length!==expected.length||keys.some((key,j)=>key!==expected[j]))throw Error('Header differs on PDF page '+i+'. Select pages with the same table layout.');
    const stop=options.lastRow?integer(options.lastRow,headerIndex+1,4001,'last PDF table row'):lines.length;
    for(const [j,line] of lines.entries()){
      const source='PDF page '+i+' · extracted row '+(j+1);
      if(j===headerIndex)continue;
      sourceCells+=Math.max(line.length,headers.length);
      sourceCharacters+=line.reduce((n,cell)=>n+cell.text.length,0);
      if(rows.length+excluded.length>=8000||sourceCells>120000||sourceCharacters>3e6)throw Error('PDF exceeds the selected text limit. Choose a smaller page range.');
      if(line.some(cell=>cell.text.length>16000))throw Error('A PDF cell exceeds 16,000 characters.');
      if(j<headerIndex||j>=stop){excluded.push({source,cells:line.map(cell=>cell.text),reason:'Outside the selected PDF table rows.'});continue;}
      rows.push({source,cells:align(line,header)});
      if(rows.length>MAX_ROWS)throw Error('PDF exceeds 4,000 data rows.');
    }
  }
  if(!rows.length)throw Error('No PDF records were found below the selected header.');
  return {headers,rows,excluded};
}
