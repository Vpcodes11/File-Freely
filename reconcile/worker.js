const ready=import('./worker.mjs');
self.addEventListener('message',async event=>{
  try{
    const {runCommand}=await ready;
    await runCommand(event.data);
  }catch(error){
    self.postMessage({id:event.data.id,error:error instanceof Error?error.message:'The document could not be processed.'});
  }
});
