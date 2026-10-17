import { inspectArchive } from './importer.js';
import { openVault } from './storage.js';
import { assessCompatibility, migrateSave, cloneEditedSave, validateSaveRecord, restartFromCheckpoint } from './compatibility.js';
import { createRuntime } from './runtime.js';
import { createDemoArchive } from './demo.js';
import { prepareLegacySaves } from './save-import.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => crypto.randomUUID();
const copy = value => structuredClone(value);
const date = value => new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
// Each game gets a stable book-cloth colour for its spine in the library.
const SPINES = ['#7a2e26','#2f4a6b','#3d5a3a','#8a6424','#5b3a5e','#2e5d5c','#6b4a2f','#4a4f63'];
const spine = id => SPINES[[...String(id)].reduce((hash,c)=>(hash*31+c.charCodeAt(0))>>>0,7)%SPINES.length];
const plural = (count,word) => `${count} ${word}${count===1?'':'s'}`;
const bytes = value => value > 1024**2 ? `${(value/1024**2).toFixed(1)} MB` : `${Math.ceil(value/1024)} KB`;
let db, games = [], versions = [], saves = [], selected = null, tab = 'saves';
let runtime = null, session = null, storage = {}, saveQueue = Promise.resolve(), autoTimer, busy = false, launching = false;

function notify(message,error=false) {
  $('#notice').textContent=message; $('#notice').className=error?'error':''; $('#notice').hidden=false;
}
function report(error) { console.error(error); const message=error?.message || String(error);notify(message,true);if(session){$('#runtime-status').textContent=message;$('#runtime-status').hidden=false;$('#save-status').textContent='Save needs attention';} }
function modal(html,init) {
  $('#modal-body').innerHTML=html; $('#modal').showModal(); init?.($('#modal-body'));
  $('#modal-body').querySelectorAll('[data-close]').forEach(el=>el.onclick=()=>$('#modal').close());
}
function button(action,label,extra='') { return `<button data-action="${action}" ${extra}>${label}</button>`; }
async function refresh() {
  [games,versions,saves]=await Promise.all(['games','versions','saves'].map(x=>db.getAll(x)));
  games.sort((a,b)=>a.title.localeCompare(b.title));
  if(selected&&!games.some(g=>g.id===selected))selected=null;
  if(!selected&&games.length)selected=games[0].id;
  render();
}
function render() {
  $('#game-count').textContent=games.length;
  const term=$('#search').value.toLowerCase();
  $('#games').innerHTML=games.filter(g=>g.title.toLowerCase().includes(term)).map(g=>`<button class="game-card ${g.id===selected?'active':''}" data-game="${esc(g.id)}"><span class="spine" style="--spine:${spine(g.id)}" aria-hidden="true">${esc(g.title.charAt(0).toUpperCase())}</span><span><strong>${esc(g.title)}</strong><small>${plural(versions.filter(v=>v.gameId===g.id).length,'version')} · ${plural(saves.filter(s=>s.gameId===g.id).length,'save')}</small></span></button>`).join('');
  $('#games').querySelectorAll('[data-game]').forEach(el=>el.onclick=()=>{selected=el.dataset.game;render();});
  if(!selected)return;
  const game=games.find(g=>g.id===selected), installed=versions.filter(v=>v.gameId===selected).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const active=installed.find(v=>v.id===game.activeVersionId) || installed[0];
  const gameSaves=saves.filter(s=>s.gameId===selected).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  $('#detail').innerHTML=`<div class="detail-head"><div>${game.identity?`<p class="identity">${esc(game.identity)}</p>`:''}<h2>${esc(game.title)}</h2><p class="detail-sub">${esc(active?.label||'No version installed')} · ${installed.length} installed ${installed.length===1?'version':'versions'}</p></div><button class="primary" id="play-new">Start a new playthrough</button></div><div class="tabs" role="tablist"><button role="tab" aria-selected="${tab==='saves'}" class="tab ${tab==='saves'?'active':''}" data-tab="saves">Saves <span class="count">${gameSaves.length}</span></button><button role="tab" aria-selected="${tab==='versions'}" class="tab ${tab==='versions'?'active':''}" data-tab="versions">Versions <span class="count">${installed.length}</span></button></div>${tab==='saves'?`<div class="toolbar"><p>Every version. Every saved path.</p><button id="import-save" class="small-button">Import save</button></div><div class="save-list">${gameSaves.length?gameSaves.map(s=>saveRow(s,active)).join(''):'<div class="no-saves">Your next choice is the first one.<br>Start playing to create automatic snapshots, or save a named one at any time.</div>'}</div>`:`<div class="toolbar"><p>Import updates into this game to keep its saves together.</p><button id="add-version" class="small-button">Import update</button></div><div class="save-list">${installed.map(v=>`<div class="version-row ${v.id===active.id?'is-active':''}"><div><strong>${esc(v.label)} ${v.id===active.id?'<span class="badge">Active</span>':''}</strong><small>Imported ${date(v.createdAt)} · ${bytes(v.files.reduce((n,f)=>n+f.data.length,0))}<br>${Object.keys(v.sceneIndex||{}).length} indexed scenes · ${esc(v.storeName||'No storage ID')}</small></div><div class="row-actions">${v.id!==active.id?button('activate','Make active',`data-id="${esc(v.id)}"`):''}${button('play-version','Start new',`data-id="${esc(v.id)}"`)}</div></div>`).join('')}</div>`}<div class="update-note">Each save stays linked to the version that created it. Before restoring a save on a different version, PathOS checks whether its chapter and return points have changed. If they have, resume it on the original version.</div>`;
  $('#detail').querySelectorAll('[data-tab]').forEach(el=>el.onclick=()=>{tab=el.dataset.tab;render();});
  $('#play-new').onclick=()=>launch(game,active).catch(report);
  $('#import-save')?.addEventListener('click',()=>$('#save-file').click());
  $('#add-version')?.addEventListener('click',()=>{$('#archive-file').dataset.target=selected;$('#archive-file').click();});
  $('#detail').querySelectorAll('[data-action]').forEach(el=>el.onclick=()=>handleAction(el.dataset.action,el.dataset.id).catch(report));
}
function saveRow(save,active) {
  const source=versions.find(v=>v.id===save.versionId), compatibility=assessCompatibility(save,active,source);
  const label=compatibility.status==='exact'?'Matches active version':compatibility.canResume?'Available on active version':'Play on original version';
  return `<div class="save-row kind-${esc(save.kind||'manual')}"><div><strong>${esc(save.name || 'Untitled save')} ${save.kind==='auto'?'<span class="badge">Auto</span>':''}</strong><small>${esc(save.snapshot.scene.name)} · ${date(save.createdAt)}<br>${esc(source?.label||'Original version missing')}</small><span class="compat ${compatibility.canResume?'':'blocked'}">${label}</span></div><div class="row-actions">${button('resume','Resume',`class="secondary" data-id="${esc(save.id)}"`)}${button('edit','Edit',`data-id="${esc(save.id)}"`)}${button('export','Export',`data-id="${esc(save.id)}"`)}${button('delete','Delete',`class="danger" data-id="${esc(save.id)}"`)}</div></div>`;
}
async function handleAction(action,id) {
  const save=saves.find(s=>s.id===id), game=games.find(g=>g.id===selected), active=versions.find(v=>v.id===game.activeVersionId);
  if(action==='activate'){await db.put('games',{...game,activeVersionId:id});await refresh();return;}
  if(action==='play-version'){await launch(game,versions.find(v=>v.id===id));return;}
  if(action==='edit'){openEditor(save);return;}
  if(action==='export'){await exportFile(`${safeName(game.title)}-${safeName(save.name)}.json`,{format:'story-vault-save',version:1,game:{identity:game.identity,title:game.title},source:{contentHash:versions.find(v=>v.id===save.versionId)?.contentHash},save});return;}
  if(action==='delete'){
    modal(`<h2>Delete this snapshot?</h2><p>${esc(save.name)} will be deleted. Your other saves and game versions won’t be affected.</p><div class="modal-actions"><button data-close>Cancel</button><button id="delete-confirm" class="primary">Delete snapshot</button></div>`,()=>{$('#delete-confirm').onclick=async()=>{try{await db.delete('saves',id);$('#modal').close();await refresh();}catch(e){report(e);}};});return;
  }
  if(action==='resume'){
    const source=versions.find(v=>v.id===save.versionId), check=assessCompatibility(save,active,source);
    if(check.status==='exact'){await launch(game,active,save);return;}
    modal(`<h2>Choose a version</h2><p>${esc(check.reason)}</p>${check.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}<div class="metadata"><span>Save: ${esc(source?.label||'unknown')}</span><span>Active: ${esc(active?.label||'unknown')}</span></div><p>Restarting the chapter plays the updated chapter from its beginning, using your stats from just before you entered it. Some changes by the author may still mean starting a new playthrough. A restarted chapter begins with empty in-game storage; the game’s built-in save slots and preferences stay with your original save.</p><div class="modal-error" id="resume-error"></div><div class="modal-actions"><button data-close>Cancel</button>${source?'<button id="resume-original" class="secondary">Use original version</button>':''}${check.canResume?'<button id="resume-active" class="primary">Resume a copy on active version</button>':''}${!check.canResume&&check.canRestartCheckpoint?'<button id="restart-checkpoint" class="secondary">Restart chapter on active version</button>':''}</div>`,()=>{
      $('#restart-checkpoint')?.addEventListener('click',async()=>{try{const restarted=restartFromCheckpoint(save,active,source);await db.putSave(restarted);$('#modal').close();await launch(game,active,restarted);}catch(e){$('#resume-error').textContent=e.message;}});
      $('#resume-original')?.addEventListener('click',()=>{$('#modal').close();launch(game,source,save).catch(report);});
      $('#resume-active')?.addEventListener('click',async()=>{try{const migrated=migrateSave(save,active,source);await db.putSave(migrated);$('#modal').close();await launch(game,active,migrated);}catch(e){$('#resume-error').textContent=e.message;}});
    });
  }
}

async function importArchive(file,targetGameId) {
  if(busy)return;busy=true;$('#import').disabled=true;notify('Inspecting game files…');
  try{
    const result=await inspectArchive(file,{filename:file.name});
    const candidates=result.candidates;
    if(!candidates.length)throw new Error('No supported ChoiceScript entry point was found.');
    const suggested=targetGameId||games.find(g=>g.identity&&candidates[0].storeName&&g.identity.toLowerCase()===candidates[0].storeName.toLowerCase())?.id||'';
    const identity=candidates[0].storeName || '';
    modal(`<h2>Add to your library</h2><p>The file stays on your device. Choose which game this version belongs to.</p><div class="form-row"><label for="entry">Entry page</label><select id="entry">${candidates.map((c,i)=>`<option value="${i}">${esc(c.title)} — ${esc(c.entryPath)}</option>`).join('')}</select></div><div class="form-row"><label for="destination">Library</label><select id="destination"><option value="">Add as a new game</option>${games.map(g=>`<option value="${esc(g.id)}" ${suggested===g.id?'selected':''}>Update ${esc(g.title)}</option>`).join('')}</select></div><div class="form-row"><label for="game-title">Title</label><input id="game-title" maxlength="200" value="${esc(candidates[0].title)}"></div><div class="form-row"><label for="version-label">Version label</label><input id="version-label" maxlength="100" value="${esc(candidates[0].versionName || file.name.replace(/\.(apk|zip)$/i,''))}"></div><p id="detected-id">Detected game ID: ${esc(identity||'none found. To import an update, choose the existing game under Library.')}</p>${result.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}<div class="modal-error" id="import-error"></div><div class="modal-actions"><button data-close>Cancel</button><button id="confirm-import" class="primary">Import version</button></div>`,()=>{
      $('#entry').onchange=()=>{const c=candidates[Number($('#entry').value)];$('#game-title').value=c.title;$('#detected-id').textContent=`Detected game ID: ${c.storeName||'not found'}`;};
      $('#confirm-import').onclick=async()=>{
        $('#confirm-import').disabled=true;
        try{
          const candidate=candidates[Number($('#entry').value)], destination=$('#destination').value;
          const existing=games.find(g=>g.id===destination);
          const duplicate=versions.find(v=>v.gameId===destination&&v.contentHash===candidate.contentHash);
          if(duplicate)throw new Error(`This exact game version is already installed as “${duplicate.label}”.`);
          const now=new Date().toISOString(), versionId=uid();
          const game=existing?{...existing,activeVersionId:versionId}:{id:uid(),title:$('#game-title').value.trim()||candidate.title,identity:candidate.storeName||'',activeVersionId:versionId,createdAt:now};
          const version={...candidate,id:versionId,gameId:game.id,label:$('#version-label').value.trim()||'Imported version',createdAt:now,filename:file.name};
          await db.importVersion(game,version);
          selected=game.id;tab='saves';$('#modal').close();await refresh();
          notify(existing?'Update imported. All your earlier saves and versions are still here.':'Game imported. Start a new playthrough when you’re ready.');
          if(db.storageKind==='browser')requestPersistence().catch(()=>{});
        }catch(e){$('#import-error').textContent=e.message;$('#confirm-import').disabled=false;}
      };
    });
  }finally{busy=false;$('#import').disabled=false;}
}

async function launch(game,version,save) {
  if(launching)return;
  if(!version)throw new Error('No game version is installed.');
  launching=true;$('#leave-player').disabled=true;
  try{
    if(runtime)await leavePlayer();
    const current={game,version,runId:uid(),lastFingerprint:'',sequence:0};session=current;storage=copy(save?.storage||{});
    $('#player').hidden=false;$('#playing-title').textContent=game.title;$('#playing-version').textContent=version.label;$('#save-status').textContent='Opening…';$('#runtime-status').hidden=true;$('#save-now').disabled=true;
    document.body.style.overflow='hidden';
    runtime=await createRuntime({container:$('#runtime'),version,storage,state:save?.snapshot,
      onStorage:value=>{if(session!==current)return;const changed=JSON.stringify(storage)!==JSON.stringify(value);storage=value;if(changed&&current.latestSnapshot){clearTimeout(autoTimer);autoTimer=setTimeout(()=>{if(session===current)enqueueSave(current.latestSnapshot,'auto').catch(report);},650);}},
      onSnapshot:snapshot=>{if(session!==current)return;current.latestSnapshot=snapshot;clearTimeout(autoTimer);autoTimer=setTimeout(()=>{if(session===current)enqueueSave(snapshot,'auto').catch(report);},650);},
      onStatus:status=>{
        if(session!==current)return;
        if(status.level==='error'){$('#runtime-status').textContent=status.message;$('#runtime-status').hidden=false;$('#save-status').textContent='Runtime needs attention';}
        if(status.level==='ready'){$('#save-now').disabled=false;$('#save-status').textContent='Autosave ready';}
      }
    });
  }catch(error){await leavePlayer(false);throw error;}
  finally{launching=false;$('#leave-player').disabled=false;}
}
function enqueueSave(snapshot,kind='auto',name) {
  const current=session;if(!current)return Promise.resolve();
  const savedStorage=copy(storage);
  saveQueue=saveQueue.catch(()=>{}).then(async()=>{
    if(!snapshot?.state||!snapshot?.scene?.name)throw new Error('This game has no restorable state yet.');
    const fingerprint=JSON.stringify({state:snapshot.state,storage:savedStorage,checkpoint:snapshot.checkpoint||null});
    if(kind==='auto'&&fingerprint===current.lastFingerprint)return;
    const record={id:uid(),gameId:current.game.id,versionId:current.version.id,name:name||`Auto · ${snapshot.scene.name}`,kind,createdAt:new Date().toISOString(),runId:current.runId,snapshot:copy(snapshot),storage:savedStorage};
    await db.putSave(record);
    current.lastFingerprint=fingerprint;
    if(session===current)$('#save-status').textContent=`Saved ${new Date().toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}`;
  });
  return saveQueue;
}
async function flush() {
  clearTimeout(autoTimer);
  if(runtime&&session){const snapshot=await runtime.capture();await enqueueSave(snapshot,'auto');}
  await saveQueue;
}
async function leavePlayer(capture=true) {
  if(capture)await flush();
  clearTimeout(autoTimer);runtime?.dispose();runtime=null;session=null;
  $('#player').hidden=true;$('#runtime').replaceChildren();document.body.style.overflow='';await refresh();
}
function manualSave() {
  if(!runtime)return;
  modal(`<h2>Keep this moment</h2><p>Named snapshots are kept until you delete them, separately from automatic saves.</p><div class="form-row"><label for="save-name">Snapshot name</label><input id="save-name" maxlength="160" value="${esc('My path · '+new Date().toLocaleDateString())}"></div><div class="modal-error" id="save-error"></div><div class="modal-actions"><button data-close>Cancel</button><button id="save-confirm" class="primary">Save snapshot</button></div>`,()=>{$('#save-confirm').onclick=async()=>{try{await enqueueSave(await runtime.capture(),'manual',$('#save-name').value.trim()||'Named snapshot');$('#modal').close();}catch(e){$('#save-error').textContent=e.message;}};});
}
function openEditor(save) {
  const edited=copy(save.snapshot.state);
  const variables=Object.entries(edited.stats).filter(([key,value])=>!key.startsWith('choice_')&&['number','string','boolean'].includes(typeof value));
  modal(`<h2>Edit a copy</h2><p>Change character variables or inspect the full state. Your changes are saved as a copy. Snapshots replay from the start of a page, so that page’s story commands may still change the values you edit.</p><div class="form-row"><label for="edit-name">Copy name</label><input id="edit-name" maxlength="160" value="${esc(save.name+' (edited)')}"></div><div class="tabs"><button id="vars-tab" class="tab active">Variables</button><button id="json-tab" class="tab">Raw state</button></div><div id="vars-panel" class="variable-grid">${variables.map(([key,value],i)=>`<div class="variable-row"><label for="var-${i}">${esc(key)}</label>${typeof value==='boolean'?`<select id="var-${i}" data-variable="${esc(key)}" data-type="boolean"><option ${value?'selected':''} value="true">true</option><option ${!value?'selected':''} value="false">false</option></select>`:`<input id="var-${i}" data-variable="${esc(key)}" data-type="${typeof value}" type="${typeof value==='number'?'number':'text'}" step="any" value="${esc(value)}">`}</div>`).join('')||'<p>This save has no editable character variables.</p>'}</div><div id="json-panel" hidden><label for="state-json" class="sr-only">Raw ChoiceScript state JSON</label><textarea id="state-json" spellcheck="false"></textarea><p>Scene and line fields are engine internals. Incorrect values can break this copy.</p></div><div class="modal-error" id="edit-error"></div><div class="modal-actions"><button data-close>Cancel</button><button id="edit-confirm" class="primary">Save edited copy</button></div>`,()=>{
    let raw=false;$('#state-json').value=JSON.stringify(edited,null,2);
    function syncVars(){for(const el of $('#vars-panel').querySelectorAll('[data-variable]')){const value=el.dataset.type==='number'?Number(el.value):el.dataset.type==='boolean'?el.value==='true':el.value;if(typeof value==='number'&&(!Number.isFinite(value)||el.value.trim()===''))throw new Error('Enter a valid number for '+el.dataset.variable);edited.stats[el.dataset.variable]=value;}}
    $('#json-tab').onclick=()=>{try{syncVars();$('#state-json').value=JSON.stringify(edited,null,2);raw=true;$('#vars-panel').hidden=true;$('#json-panel').hidden=false;$('#json-tab').classList.add('active');$('#vars-tab').classList.remove('active');}catch(e){$('#edit-error').textContent=e.message;}};
    $('#vars-tab').onclick=()=>{if(raw){$('#edit-error').textContent='Raw state edits can’t be shown as variables. Save the copy, or close and reopen the editor to start over.';} };
    $('#edit-confirm').onclick=async()=>{try{let record=cloneEditedSave(save,{},$('#edit-name').value.trim()||save.name+' (edited)');if(raw)record.snapshot.state=JSON.parse($('#state-json').value);else{syncVars();record.snapshot.state=edited;}validateSaveRecord(record);await db.putSave(record);$('#modal').close();await refresh();notify('Saved an edited copy. The original snapshot is still available.');}catch(e){$('#edit-error').textContent=e.message;}};
  });
}

function safeName(value){return String(value||'pathos').replace(/[^a-z0-9_-]+/gi,'-').slice(0,100);}
async function exportFile(name,value){
  const data=JSON.stringify(value,null,2), mime='application/json';
  if(window.VaultNative?.exportFile){await window.VaultNative.exportFile({name,data,mime});return;}
  const blob=new Blob([data],{type:mime});
  const file=new File([blob],name,{type:mime});
  if(navigator.canShare?.({files:[file]})&&navigator.share){try{await navigator.share({files:[file],title:name});return;}catch(error){if(error.name==='AbortError')return;}}
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function importSave(file){
  if(file.size>20*1024*1024)throw new Error('This save file is larger than 20 MB.');
  const envelope=JSON.parse(await file.text());
  const game=games.find(g=>g.id===selected);if(!game)throw new Error('Import the matching game first.');
  if(envelope.format!=='story-vault-save'){
    if(envelope.format==='story-vault-backup')throw new Error('Use Restore backup to import a complete library.');
    return previewLegacyImport(envelope,game);
  }
  if(envelope.version!==1)throw new Error('This PathOS save file uses an unsupported format version.');
  const contentHash=envelope.source?.contentHash, source=versions.find(v=>v.gameId===game.id&&v.contentHash===contentHash);
  if(!source)throw new Error('The game version that created this save isn’t installed for the selected game. Install that version first so the save can be verified.');
  const record={...envelope.save,id:uid(),gameId:game.id,versionId:source.id,createdAt:new Date().toISOString(),name:(envelope.save.name||'Imported save')+' (imported)'};
  validateSaveRecord(record);await db.putSave(record);await refresh();notify('Save imported into the selected game.');
}
function previewLegacyImport(envelope,game){
  const installed=versions.filter(v=>v.gameId===game.id);
  modal(`<h2>Import an earlier save</h2><p>Choose the game version that created this ChoiceScript save. Raw saves and full save bundles from the earlier DinoKnights editor are supported.</p><div class="form-row"><label for="legacy-version">Original game version</label><select id="legacy-version">${installed.map(v=>`<option value="${esc(v.id)}" ${game.activeVersionId===v.id?'selected':''}>${esc(v.label)}</option>`).join('')}</select></div><div id="legacy-preview"></div><div class="form-row"><label><input id="legacy-confirm" type="checkbox" style="width:auto;margin-right:8px">This save belongs to this game and the selected original version.</label></div><div class="modal-error" id="legacy-error"></div><div class="modal-actions"><button data-close>Cancel</button><button id="legacy-import" class="primary" disabled>Import saved positions</button></div>`,()=>{
    let prepared=null;
    function preview(){
      $('#legacy-confirm').checked=false;$('#legacy-import').disabled=true;
      try{const version=installed.find(v=>v.id===$('#legacy-version').value);prepared=prepareLegacySaves(envelope,{game,version});$('#legacy-preview').innerHTML=`<p>${prepared.length} saved ${prepared.length===1?'position':'positions'} ready.</p>${prepared.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}`;$('#legacy-error').textContent='';}
      catch(error){prepared=null;$('#legacy-preview').textContent='';$('#legacy-error').textContent=error.message;}
    }
    $('#legacy-version').onchange=preview;
    $('#legacy-confirm').onchange=()=>{$('#legacy-import').disabled=!prepared||!$('#legacy-confirm').checked;};
    $('#legacy-import').onclick=async()=>{try{if(!prepared||!$('#legacy-confirm').checked)return;$('#legacy-import').disabled=true;await db.putSaves(prepared);$('#modal').close();await refresh();notify('Saves imported. The original file is unchanged.');}catch(error){$('#legacy-error').textContent=error.message;$('#legacy-import').disabled=false;}};
    preview();
  });
}
function isIOSWeb(){return !window.VaultNative&&(/iPad|iPhone|iPod/.test(navigator.userAgent||'')||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1));}
function isHomeScreen(){return navigator.standalone===true||window.matchMedia?.('(display-mode: standalone)').matches===true;}
function iosHomeScreenHelp(){return `<h3>Keep PathOS on your Home Screen</h3><ol><li>Export a backup of your current library to Files or iCloud Drive.</li><li>Open this site in Safari. In the Share menu, choose Add to Home Screen, then tap Add. If offered, leave Open as Web App on.</li><li>Open PathOS from its Home Screen icon. If your library is empty, use Restore backup.</li><li>Tap Check device storage to request persistent storage again.</li></ol><p>Home Screen installation can help Safari grant persistent storage. Approval is decided by iOS, so keep backups even after installing.</p>`;}
async function requestPersistence(){
  try{if(await navigator.storage?.persisted?.())return true;return await navigator.storage?.persist?.()===true;}
  catch{return false;}
}
function setupStorageHelp(){
  const native=db.storageKind==='native';
  $('#local-storage-note').textContent=native?'Games and saves use durable app storage. Export a backup to keep another copy.':'Games and saves stay in this browser. Export a backup to move them.';
  $('#ios-storage-help').hidden=!isIOSWeb()||isHomeScreen();
  $('#ios-storage-steps').onclick=()=>modal(`${iosHomeScreenHelp()}<div class="modal-actions"><button data-close class="primary">Done</button></div>`);
}
async function showStorageInfo(){
  if(db.storageKind==='native'){
    const info=await db.storageInfo();
    modal(`<h2>Saved on this device</h2><p>Using ${bytes(info.usage)}. About ${bytes(info.available)} is available on the device.</p><p>Your games and saves use durable app storage and stay through app updates. Deleting the app deletes its local library.</p><p>Export a backup to Files or iCloud Drive to keep an independent copy. Device backups can include this library when backup is enabled for PathOS; this does not sync it with the web version.</p><div class="modal-actions"><button data-close class="primary">Done</button></div>`);
    return;
  }
  const persistent=await requestPersistence();
  let estimate;try{estimate=await navigator.storage?.estimate?.();}catch{/* Status and installation help are still useful. */}
  modal(`<h2>Browser storage</h2>${estimate?`<p>Using ${bytes(estimate.usage||0)} of about ${bytes(estimate.quota||0)}.</p>`:''}<p>${persistent?'Persistent storage is on. Keep backups to protect against clearing site data or losing your device.':'Persistent storage has not been confirmed. Your browser may clear this library, so export backups to keep another copy.'}</p>${isIOSWeb()?iosHomeScreenHelp():''}<div class="modal-actions"><button data-close class="primary">Done</button></div>`);
}
function help(){modal(`<h2>Your games, kept together</h2><p>Import an APK that contains a complete ChoiceScript web game, or a ZIP of a playable ChoiceScript folder. Android code, in-app purchases, and chapters that download after installation won’t work here.</p><ol><li>Import a game and start playing. Automatic snapshots keep your recent positions; named snapshots stay until you delete them.</li><li>When a game gets an update, import the new APK and choose the same game under “Library.” This works even if the update’s detected game ID has changed.</li><li>All saves appear in one list. When you resume, PathOS checks the saved chapter against the version you picked. If the save can’t continue there, you can still play it on its original version.</li><li>Use Edit to make a modified copy. Export a single save or a full backup to move between browsers and the iOS app.</li></ol><p>${db.storageKind==='native'?'Your library is saved in the app’s durable device storage. It stays through app updates, but deleting the app deletes its local data.':'Your library is stored in this browser, for this site address only. Keep using the same address so it carries over to new releases.'} The browser and iOS app keep separate libraries and don’t sync. Backups include the imported game files, so keep them private.</p>${isIOSWeb()?iosHomeScreenHelp():''}<p>Export a backup to Files or iCloud Drive to protect against losing your device or deleting local data.</p><div class="modal-actions"><button id="help-restore" class="secondary">Restore backup</button><button data-close class="primary">Done</button></div>`,()=>{$('#help-restore').onclick=()=>{$('#modal').close();$('#backup-file').click();};});}

$('#import').onclick=()=>{delete $('#archive-file').dataset.target;$('#archive-file').click();};
$('#archive-file').onchange=event=>{const file=event.target.files[0];if(file)importArchive(file,event.target.dataset.target).catch(report);event.target.value='';};
$('#save-file').onchange=event=>{const file=event.target.files[0];if(file)importSave(file).catch(report);event.target.value='';};
$('#backup').onclick=async()=>{try{if(runtime)await flush();notify('Preparing a backup of games, versions, and saves…');await exportFile('PathOS-Backup-'+new Date().toISOString().slice(0,10)+'.json',await db.exportBackup());notify('Backup ready. Keep a copy somewhere outside PathOS.');}catch(e){report(e);}};
$('#restore-backup').onclick=()=>$('#backup-file').click();
$('#backup-file').onchange=async event=>{const file=event.target.files[0];event.target.value='';if(!file)return;try{
  if(file.size>700*1024*1024)throw new Error('This backup is too large to restore here.');
  const backup=JSON.parse(await file.text());
  modal(`<h2>Restore a library backup</h2><p>This adds ${esc(backup.games?.length??'?')} games and ${esc(backup.saves?.length??'?')} saves to the library on this device. PathOS checks for conflicts before changing anything.</p><div class="modal-error" id="restore-error"></div><div class="modal-actions"><button data-close>Cancel</button><button id="restore-confirm" class="primary">Restore backup</button></div>`,()=>{$('#restore-confirm').onclick=async()=>{try{$('#restore-confirm').disabled=true;await db.restoreBackup(backup);$('#modal').close();await refresh();notify('Backup restored. Games and saves are available on this device.');}catch(e){$('#restore-error').textContent=e.message;$('#restore-confirm').disabled=false;}};});
}catch(e){report(e);}};
$('#search').oninput=render;$('#help').onclick=help;$('#save-now').onclick=manualSave;
$('#leave-player').onclick=()=>leavePlayer().catch(error=>{modal(`<h2>No new snapshot was saved</h2><p>${esc(error.message)}</p><p>Wait for the game to finish loading and try again, or return to the library. Your existing snapshots are safe.</p><div class="modal-actions"><button data-close>Keep playing</button><button id="leave-without-save" class="primary">Return to library</button></div>`,()=>{$('#leave-without-save').onclick=()=>{$('#modal').close();leavePlayer(false).catch(report);};});});
$('#storage-info').onclick=()=>showStorageInfo().catch(report);
$('#demo').onclick=async()=>{try{const file=await createDemoArchive();await importArchive(file);}catch(e){report(e);}};
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flush().catch(report);});
document.addEventListener('vault-native-pause',()=>flush().catch(report).finally(()=>window.VaultNative?.storage?.({operation:'backgroundSaveFinished'}).catch(report)));
window.addEventListener('pagehide',()=>{flush().catch(()=>{});});

try{db=await openVault();setupStorageHelp();await refresh();if('serviceWorker' in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./sw.js').catch(error=>console.warn('Offline shell unavailable',error));}catch(error){report(error);$('#import').disabled=true;}
