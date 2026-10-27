import { inspectArchive } from './importer.js';
import { openVault, decodeBackup, bytesToBase64 } from './storage.js';
import { assessCompatibility, migrateSave, cloneEditedSave, validateSaveRecord, restartFromCheckpoint } from './compatibility.js';
import { createRuntime } from './runtime.js';
import { createDemoArchive } from './demo.js';
import { prepareLegacySaves } from './save-import.js';
import { encodeSave, readSaveFile } from './transfer.js';
import { DEFAULT_SETTINGS, READER_FONTS, normalizeSettings, resolvedTheme, readerStyles } from './settings.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => crypto.randomUUID();
const copy = value => structuredClone(value);
const date = value => new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'});
// Each game gets a stable book-cloth colour for its spine in the library.
const SPINES = ['#7a2e26','#2f4a6b','#3d5a3a','#8a6424','#5b3a5e','#2e5d5c','#6b4a2f','#4a4f63'];
const spine = id => SPINES[[...String(id)].reduce((hash,c)=>(hash*31+c.charCodeAt(0))>>>0,7)%SPINES.length];
const plural = (count,word) => `${count} ${word}${count===1?'':'s'}`;
const bytes = value => value > 1024**2 ? `${(value/1024**2).toFixed(1)} MB` : `${Math.ceil(value/1024)} KB`;
let db, games = [], versions = [], saves = [], selected = null, tab = 'saves';
let runtime = null, session = null, storage = {}, saveQueue = Promise.resolve(), autoTimer, busy = false, launching = false;
let selectingSaves = false, selectionGame = null;
let debugChoices = false;
let settings = { ...DEFAULT_SETTINGS };
const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
const selectedSaves = new Set();
const emptyDetail = $('#detail').innerHTML;

const disclosures = [['main-menu-toggle','main-menu'],['reader-menu-toggle','reader-actions']];
function closeMenus(focus=false) {
  for(const [triggerId,panelId] of disclosures){
    const trigger=$('#'+triggerId);
    if(trigger.getAttribute('aria-expanded')==='true'){
      trigger.setAttribute('aria-expanded','false');$('#'+panelId).classList.remove('is-open');
      if(focus)trigger.focus();
    }
  }
}
function toggleMenu(triggerId,panelId) {
  const trigger=$('#'+triggerId), open=trigger.getAttribute('aria-expanded')!=='true';
  closeMenus();trigger.setAttribute('aria-expanded',String(open));$('#'+panelId).classList.toggle('is-open',open);
}
function notify(message,error=false) {
  $('#notice').textContent=message; $('#notice').className=error?'error':''; $('#notice').hidden=false;
}
function report(error) { console.error(error); const message=error?.message || String(error);notify(message,true);if(session){$('#runtime-status').textContent=message;$('#runtime-status').hidden=false;$('#save-status').textContent='Save needs attention';} }
function modal(html,init) {
  closeMenus(true);
  $('#modal-body').innerHTML=html; $('#modal').showModal(); init?.($('#modal-body'));
  $('#modal-body').querySelectorAll('[data-close]').forEach(el=>el.onclick=()=>$('#modal').close());
}
function button(action,label,extra='') { return `<button data-action="${action}" ${extra}>${label}</button>`; }
function currentReaderStyles(){return readerStyles(settings,systemTheme?.matches||false);}
async function applySettings(){
  document.documentElement.dataset.theme=settings.theme;
  document.documentElement.dataset.reduceMotion=String(settings.reduceMotion);
  const dark=resolvedTheme(settings,systemTheme?.matches||false)==='dark';
  document.querySelectorAll('meta[name="theme-color"]').forEach(meta=>meta.content=dark?'#1a1814':'#f4efe4');
  if(!settings.autosaveLimit){clearTimeout(autoTimer);if(session)$('#save-status').textContent='Autosave off';}
  await runtime?.setAppearance?.(currentReaderStyles());
}
function openSettings(){
  const options=entries=>entries.map(([value,label])=>`<option value="${value}">${label}</option>`).join('');
  modal(`<h2>Settings</h2><p>Saved on this device. Reader changes apply to the open game without restarting it.</p>
    <fieldset class="settings-section"><legend>Appearance</legend><div class="form-row"><label for="settings-theme">Color theme</label><select id="settings-theme">${options([['system','Follow device'],['light','Light'],['dark','Dark']])}</select></div><label class="settings-check"><input id="settings-reduceMotion" type="checkbox">Reduce motion</label></fieldset>
    <fieldset class="settings-section"><legend>Reader</legend><label class="settings-check"><input id="settings-useGameAppearance" type="checkbox">Use the game’s original appearance</label><p class="settings-hint">Turn this off to use PathOS fonts and colors inside games.</p><div class="settings-grid">
    <div class="form-row"><label for="settings-fontFamily">Font</label><select id="settings-fontFamily">${options([['serif','Book serif'],['sans','System sans serif'],['mono','Monospace']])}</select></div>
    <div class="form-row"><label for="settings-fontSize">Font size (px)</label><input id="settings-fontSize" type="number" min="14" max="32" step="1"></div>
    <div class="form-row"><label for="settings-lineHeight">Line spacing</label><input id="settings-lineHeight" type="number" min="1.2" max="2.2" step="0.05"></div>
    <div class="form-row"><label for="settings-readerWidth">Reading width</label><select id="settings-readerWidth">${options([['narrow','Narrow'],['comfortable','Comfortable'],['wide','Wide'],['full','Full width']])}</select></div></div>
    <div id="settings-preview" class="settings-preview" aria-label="Reader preview">You reach a lighthouse as the last light leaves the sea.</div></fieldset>
    <fieldset class="settings-section"><legend>Automatic saves</legend><div class="form-row"><label for="settings-autosaveLimit">Snapshots to keep per version</label><input id="settings-autosaveLimit" type="number" min="0" max="100" step="1" aria-describedby="settings-autosave-hint"></div><p id="settings-autosave-hint" class="settings-hint">0 stops new autosaves and keeps existing snapshots. Lowering a positive limit removes older autosaves. Named snapshots are kept until you delete them.</p><label class="settings-check"><input id="settings-saveContinuations" type="checkbox">Also autosave text-only “Next” pages</label></fieldset>
    <div class="modal-error" id="settings-error" role="alert"></div><div class="modal-actions"><button id="settings-reset">Reset defaults</button><button data-close>Cancel</button><button id="settings-save" class="primary">Save settings</button></div>`,()=>{
    const controls=Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key=>[key,$('#settings-'+key)]));
    function read(){return Object.fromEntries(Object.entries(controls).map(([key,control])=>[key,control.type==='checkbox'?control.checked:['autosaveLimit','fontSize','lineHeight'].includes(key)?control.value.trim()===''?NaN:Number(control.value):control.value]));}
    function preview(){
      const draft=normalizeSettings(read()),sample=$('#settings-preview'),dark=resolvedTheme(draft,systemTheme?.matches||false)==='dark';
      for(const key of ['fontFamily','fontSize','lineHeight','readerWidth'])controls[key].disabled=draft.useGameAppearance;
      sample.hidden=draft.useGameAppearance;
      Object.assign(sample.style,{fontFamily:READER_FONTS[draft.fontFamily],fontSize:draft.fontSize+'px',lineHeight:String(draft.lineHeight),backgroundColor:dark?'#1a1814':'#fbf8f1',color:dark?'#ebe4d5':'#1e1b16'});
      controls.saveContinuations.disabled=draft.autosaveLimit===0;
    }
    function fill(value){for(const [key,control] of Object.entries(controls)){
      if(control.type==='checkbox')control.checked=value[key];
      else if(control.tagName==='SELECT')control.querySelectorAll('option').forEach(option=>option.selected=option.value===value[key]);
      else control.value=String(value[key]);
    }preview();}
    fill(settings);
    for(const control of Object.values(controls)){control.oninput=preview;control.onchange=preview;}
    $('#settings-reset').onclick=()=>fill(DEFAULT_SETTINGS);
    $('#settings-save').onclick=async()=>{
      const save=$('#settings-save'),error=$('#settings-error');save.disabled=true;error.textContent='';
      try{const draft=normalizeSettings(read(),true);settings=await db.saveSettings(draft);await applySettings();await refresh();$('#modal').close();notify('Settings saved.');}
      catch(e){error.textContent=e.message;save.disabled=false;}
    };
  });
}
async function refresh() {
  [games,versions,saves]=await Promise.all(['games','versions','saves'].map(x=>db.getAll(x)));
  games.sort((a,b)=>a.title.localeCompare(b.title));
  if(selected&&!games.some(g=>g.id===selected))selected=null;
  if(!selected&&games.length)selected=games[0].id;
  render();
}
function render() {
  $('#game-count').textContent=games.length;
  const selectedGame=games.find(game=>game.id===selected);
  $('#menu-import-save').disabled=!selectedGame;
  $('#menu-game-context').textContent=selectedGame?`Into ${selectedGame.title}`:'Import a game first';
  const term=$('#search').value.toLowerCase();
  $('#games').innerHTML=games.filter(g=>g.title.toLowerCase().includes(term)).map(g=>`<button class="game-card ${g.id===selected?'active':''}" data-game="${esc(g.id)}"><span class="spine" style="--spine:${spine(g.id)}" aria-hidden="true">${esc(g.title.charAt(0).toUpperCase())}</span><span><strong>${esc(g.title)}</strong><small>${plural(versions.filter(v=>v.gameId===g.id&&!v.removed).length,'version')} · ${plural(saves.filter(s=>s.gameId===g.id).length,'save')}</small></span></button>`).join('');
  $('#games').querySelectorAll('[data-game]').forEach(el=>el.onclick=()=>{selected=el.dataset.game;render();});
  if(!selected){selectedSaves.clear();selectingSaves=false;selectionGame=null;tab='saves';$('#detail').innerHTML=emptyDetail;$('#demo').onclick=exploreDemo;return;}
  const game=games.find(g=>g.id===selected), installed=versions.filter(v=>v.gameId===selected&&!v.removed).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const active=installed.find(v=>v.id===game.activeVersionId) || installed[0];
  const gameSaves=saves.filter(s=>s.gameId===selected).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  if(selectionGame!==selected || tab!=='saves'){selectedSaves.clear();selectingSaves=false;selectionGame=selected;}
  const visibleIds=new Set(gameSaves.map(save=>save.id));
  for(const id of selectedSaves)if(!visibleIds.has(id))selectedSaves.delete(id);
  $('#detail').innerHTML=`<div class="detail-head"><div>${game.identity?`<p class="identity">${esc(game.identity)}</p>`:''}<h2>${esc(game.title)}</h2><p class="detail-sub">${esc(active?.label||'No version installed')} · ${installed.length} installed ${installed.length===1?'version':'versions'}</p></div><button class="primary" id="play-new">Start a new playthrough</button></div><div class="tabs" role="tablist"><button role="tab" aria-selected="${tab==='saves'}" class="tab ${tab==='saves'?'active':''}" data-tab="saves">Saves <span class="count">${gameSaves.length}</span></button><button role="tab" aria-selected="${tab==='versions'}" class="tab ${tab==='versions'?'active':''}" data-tab="versions">Versions <span class="count">${installed.length}</span></button></div>${tab==='saves'?`${savesToolbar(gameSaves)}<div class="save-list">${gameSaves.length?gameSaves.map(s=>saveRow(s,active)).join(''):'<div class="no-saves">Your next choice is the first one.<br>Start playing to create automatic snapshots, or save a named one at any time.</div>'}</div>`:`<div class="toolbar"><p>Import updates into this game to keep its saves together.</p><button id="add-version" class="small-button">Import update</button></div><div class="save-list">${installed.map(v=>`<div class="version-row ${v.id===active.id?'is-active':''}"><div><strong>${esc(v.label)} ${v.id===active.id?'<span class="badge">Active</span>':''}</strong><small>Imported ${date(v.createdAt)} · ${bytes(v.files.reduce((n,f)=>n+f.data.length,0))}<br>${Object.keys(v.sceneIndex||{}).length} indexed scenes · ${esc(v.storeName||'No storage ID')}</small></div><div class="row-actions">${v.id!==active.id?button('activate','Make active',`data-id="${esc(v.id)}"`):''}${button('play-version','Start new',`data-id="${esc(v.id)}"`)}${button('delete-version','Remove',`class="danger" data-id="${esc(v.id)}" aria-label="Remove ${esc(v.label)}"`)}</div></div>`).join('')}</div>`}<div class="update-note">Each save stays linked to the version that created it. Before restoring a save on a different version, PathOS checks whether its chapter and return points have changed. If they have, resume it on the original version.</div>`;
  $('#detail').querySelectorAll('[data-tab]').forEach(el=>el.onclick=()=>{tab=el.dataset.tab;render();});
  $('#play-new').onclick=()=>launch(game,active).catch(report);
  $('#import-save')?.addEventListener('click',()=>$('#save-file').click());
  $('#add-version')?.addEventListener('click',()=>{$('#archive-file').dataset.target=selected;$('#archive-file').click();});
  $('#select-saves')?.addEventListener('click',()=>{selectingSaves=true;selectedSaves.clear();render();});
  $('#cancel-save-selection')?.addEventListener('click',()=>{selectingSaves=false;selectedSaves.clear();render();});
  $('#select-all-saves')?.addEventListener('change',event=>{
    selectedSaves.clear();
    if(event.target.checked)for(const save of gameSaves)selectedSaves.add(save.id);
    updateSaveSelection();
  });
  $('#delete-selected-saves')?.addEventListener('click',()=>confirmDeleteSaves(gameSaves.filter(save=>selectedSaves.has(save.id))));
  $('#detail').querySelectorAll('[data-save-select]').forEach(el=>el.onchange=()=>{
    if(el.checked)selectedSaves.add(el.dataset.saveSelect);else selectedSaves.delete(el.dataset.saveSelect);
    updateSaveSelection();
  });
  updateSaveSelection();
  $('#detail').querySelectorAll('[data-action]').forEach(el=>el.onclick=()=>handleAction(el.dataset.action,el.dataset.id).catch(report));
}
function savesToolbar(gameSaves) {
  if(!selectingSaves)return `<div class="toolbar"><p>Every version. Every saved path.</p><div class="toolbar-actions"><button id="import-save" class="small-button">Import save</button><button id="select-saves" class="small-button" ${gameSaves.length?'':'disabled'}>Select saves</button></div></div>`;
  return '<div class="toolbar bulk-controls"><label class="select-all"><input id="select-all-saves" type="checkbox">Select all saves</label><span id="save-selection-count" role="status" aria-live="polite">0 selected</span><div class="toolbar-actions"><button id="delete-selected-saves" class="small-button danger" disabled>Delete selected</button><button id="cancel-save-selection" class="small-button">Done</button></div></div>';
}
function updateSaveSelection() {
  if(!selectingSaves)return;
  const boxes=[...$('#detail').querySelectorAll('[data-save-select]')];
  for(const box of boxes){box.checked=selectedSaves.has(box.dataset.saveSelect);box.closest('.save-row').classList.toggle('is-selected',box.checked);}
  const all=$('#select-all-saves');
  if(all){all.checked=boxes.length>0&&selectedSaves.size===boxes.length;all.indeterminate=selectedSaves.size>0&&selectedSaves.size<boxes.length;}
  if($('#save-selection-count'))$('#save-selection-count').textContent=`${selectedSaves.size} selected`;
  if($('#delete-selected-saves'))$('#delete-selected-saves').disabled=selectedSaves.size===0;
}
function saveTitle(save) {return save.kind==='auto'?`Autosave · ${save.snapshot.scene.name}`:save.name || 'Untitled save';}
function confirmDeleteSaves(records) {
  if(!records.length)return;
  const gameId=selected, ids=records.map(save=>save.id);
  if(records.some(save=>save.gameId!==gameId))throw new Error('Choose saves from the current game.');
  const count=records.length;
  modal(`<h2>Delete ${count===1?'this snapshot':plural(count,'snapshot')}?</h2><p>This permanently deletes the selected ${count===1?'snapshot':'snapshots'}.</p><ul class="delete-save-list">${records.map(save=>`<li><strong>${esc(saveTitle(save))}</strong><small>${esc(save.snapshot.scene.name)} · line ${save.snapshot.state.lineNum+1} · ${date(save.createdAt)}</small></li>`).join('')}</ul><div class="modal-error" id="delete-error"></div><div class="modal-actions"><button data-close>Cancel</button><button id="delete-confirm" class="primary">Delete ${count===1?'snapshot':plural(count,'snapshot')}</button></div>`,()=>{
    const confirm=$('#delete-confirm'), error=$('#delete-error');
    confirm.onclick=async()=>{
      confirm.disabled=true;error.textContent='';
      try{
        const removed=await db.deleteSaves(gameId,ids);
        selectedSaves.clear();selectingSaves=false;
        await refresh();$('#modal').close();notify(`${plural(removed,'snapshot')} deleted.`);
      }catch(e){error.textContent=e.message;confirm.disabled=false;}
    };
  });
}
function confirmDeleteVersion(game,version) {
  if(!version||version.gameId!==game.id||version.removed)throw new Error('Choose an installed version from this game.');
  const last=versions.filter(item=>item.gameId===game.id&&!item.removed).length===1;
  const count=saves.filter(save=>save.gameId===game.id).length;
  modal(`<h2>${last?'Remove this game?':'Remove this version?'}</h2><p><strong>${esc(game.title)} · ${esc(version.label)}</strong></p><p>${last?`This is the last installed version. Removing it permanently deletes the game and all ${plural(count,'saved snapshot')}.`:`This removes the version’s game files. Other installed versions and all ${plural(count,'saved snapshot')} stay in your library. A save that cannot use another version will need this version imported again.`}</p><div class="modal-error" id="remove-version-error"></div><div class="modal-actions"><button data-close>Cancel</button><button id="remove-version-confirm" class="primary">${last?'Remove game and saves':'Remove version'}</button></div>`,()=>{
    const confirm=$('#remove-version-confirm'),error=$('#remove-version-error');
    confirm.onclick=async()=>{
      confirm.disabled=true;error.textContent='';
      try{
        if(session?.game.id===game.id)throw new Error('Return to the library before removing a version of this game.');
        const result=await db.deleteVersion(game.id,version.id,{allowGameRemoval:last});
        selectedSaves.clear();selectingSaves=false;if(result.gameRemoved)tab='saves';
        await refresh();$('#modal').close();
        notify(result.gameRemoved?`${game.title} removed, along with ${plural(result.deletedSaves,'saved snapshot')}.`:`${version.label} removed. Your saves are still in the library.`);
      }catch(e){error.textContent=e.message;confirm.disabled=false;}
    };
  });
}
function saveRow(save,active) {
  const source=versions.find(v=>v.id===save.versionId), compatibility=assessCompatibility(save,active,source);
  const label=compatibility.status==='exact'?'Matches active version':compatibility.canResume?'Available on active version':'Play on original version';
  const automatic=save.kind==='auto', title=saveTitle(save);
  return `<div class="save-row kind-${esc(save.kind||'manual')}${selectingSaves?' is-selectable':''}">${selectingSaves?`<label class="save-select"><input type="checkbox" data-save-select="${esc(save.id)}" aria-label="${esc(`Select ${title}, ${save.snapshot.scene.name}, line ${save.snapshot.state.lineNum+1}, ${date(save.createdAt)}`)}"></label>`:''}<div class="save-description"><strong>${esc(title)} ${automatic?'<span class="badge">Automatic</span>':''}</strong>${save.snapshot.preview?`<p class="save-preview">${esc(save.snapshot.preview)}</p>`:''}<small>${esc(save.snapshot.scene.name)} · line ${save.snapshot.state.lineNum+1} · ${date(save.createdAt)}<br>${esc(source?.label||'Original version missing')}${source?.removed?' · Removed from device':''}</small><span class="compat ${compatibility.canResume?'':'blocked'}">${label}</span></div>${selectingSaves?'':`<div class="row-actions">${button('resume','Resume',`class="secondary" data-id="${esc(save.id)}"`)}${button('edit','Edit',`data-id="${esc(save.id)}"`)}${button('export','Export',`data-id="${esc(save.id)}"`)}${button('delete','Delete',`class="danger" data-id="${esc(save.id)}"`)}</div>`}</div>`;
}
async function handleAction(action,id) {
  const save=saves.find(s=>s.id===id), game=games.find(g=>g.id===selected), active=versions.find(v=>v.id===game.activeVersionId);
  if(action==='activate'){await db.put('games',{...game,activeVersionId:id});await refresh();return;}
  if(action==='play-version'){await launch(game,versions.find(v=>v.id===id));return;}
  if(action==='delete-version'){confirmDeleteVersion(game,versions.find(v=>v.id===id));return;}
  if(action==='edit'){openEditor(save);return;}
  if(action==='export'){await exportFile(`${safeName(game.title)}-${safeName(save.name)}.pathos-save.zip`,await encodeSave({game:{identity:game.identity,title:game.title},source:{contentHash:versions.find(v=>v.id===save.versionId)?.contentHash},save}));return;}
  if(action==='delete'){
    confirmDeleteSaves([save]);return;
  }
  if(action==='resume'){
    const source=versions.find(v=>v.id===save.versionId), check=assessCompatibility(save,active,source);
    if(check.status==='exact'){await launch(game,active,save);return;}
    modal(`<h2>Choose a version</h2><p>${esc(check.reason)}</p>${source?.removed?'<p>The original version was removed from this device. Import it again to resume on that version.</p>':''}${check.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}<div class="metadata"><span>Save: ${esc(source?.label||'unknown')}</span><span>Active: ${esc(active?.label||'unknown')}</span></div><p>Restarting the chapter plays the updated chapter from its beginning, using your stats from just before you entered it. Some changes by the author may still mean starting a new playthrough. A restarted chapter begins with empty in-game storage; the game’s built-in save slots and preferences stay with your original save.</p><div class="modal-error" id="resume-error"></div><div class="modal-actions"><button data-close>Cancel</button>${source&&!source.removed?'<button id="resume-original" class="secondary">Use original version</button>':''}${check.canResume?'<button id="resume-active" class="primary">Resume a copy on active version</button>':''}${!check.canResume&&check.canRestartCheckpoint?'<button id="restart-checkpoint" class="secondary">Restart chapter on active version</button>':''}</div>`,()=>{
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
          if(duplicate&&!duplicate.removed)throw new Error(`This exact game version is already installed as “${duplicate.label}”.`);
          const now=new Date().toISOString(), versionId=duplicate?.id||uid();
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

let fileDragDepth=0;
function isFileDrag(event){return Array.from(event.dataTransfer?.types||[]).includes('Files')||Array.from(event.dataTransfer?.items||[]).some(item=>item.kind==='file');}
function dropBlockReason(){
  if(!db)return 'The library is opening. Try again shortly.';
  if(runtime||launching)return 'Return to the library to import a game.';
  if(busy||$('#modal').open)return 'Finish or close the current dialog before importing a game.';
  return '';
}
function showGameDrop(){
  const blocked=dropBlockReason();
  $('#game-drop-title').textContent=blocked?'Game import paused':'Drop a game file';
  $('#game-drop-hint').textContent=blocked||'APK or ZIP · Imported only on this device';
  $('#game-drop-target').hidden=false;
}
function clearGameDrop(){fileDragDepth=0;$('#game-drop-target').hidden=true;}
document.addEventListener('dragenter',event=>{
  if(!isFileDrag(event))return;
  event.preventDefault();fileDragDepth++;showGameDrop();
});
document.addEventListener('dragover',event=>{
  if(!isFileDrag(event))return;
  event.preventDefault();event.dataTransfer.dropEffect=dropBlockReason()?'none':'copy';showGameDrop();
});
document.addEventListener('dragleave',event=>{
  if($('#game-drop-target').hidden)return;
  fileDragDepth=Math.max(0,fileDragDepth-1);
  if(!fileDragDepth)clearGameDrop();
});
document.addEventListener('drop',event=>{
  if(!isFileDrag(event)&&$('#game-drop-target').hidden)return;
  event.preventDefault();clearGameDrop();
  const reason=dropBlockReason();if(reason){notify(reason,true);return;}
  const files=Array.from(event.dataTransfer?.files||[]);
  if(files.length!==1){notify('Drop one APK or ZIP game file at a time.',true);return;}
  if(!/\.(apk|zip)$/i.test(files[0].name)){notify('Choose an APK or ZIP game file.',true);return;}
  importArchive(files[0]).catch(report);
});
document.addEventListener('dragend',clearGameDrop);
window.addEventListener('blur',clearGameDrop);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')clearGameDrop();});

async function launch(game,version,save) {
  if(launching)return;
  if(!version||version.removed)throw new Error('Import this game version again before playing it.');
  closeMenus();
  launching=true;$('#leave-player').disabled=true;
  try{
    if(runtime)await leavePlayer();
    const current={game,version,runId:uid(),lastFingerprint:save?saveFingerprint(save.snapshot,save.storage):'',lastChangeFingerprint:save?saveFingerprint(save.snapshot,save.storage,true):''};session=current;storage=copy(save?.storage||{});
    $('#player').hidden=false;$('#playing-title').textContent=game.title;$('#playing-version').textContent=version.label;$('#save-status').textContent='Opening…';$('#runtime-status').hidden=true;$('#save-now').disabled=true;
    $('#debug-choices').disabled=true;$('#debug-choices').setAttribute('aria-pressed',String(debugChoices));
    document.body.style.overflow='hidden';
    runtime=await createRuntime({container:$('#runtime'),version,storage,state:save?.snapshot,debugMode:debugChoices,appearanceCSS:currentReaderStyles(),
      onStorage:value=>{if(session!==current)return;const changed=JSON.stringify(storage)!==JSON.stringify(value);storage=value;if(changed&&current.latestSnapshot)scheduleAutosave(current,current.latestSnapshot);},
      onSnapshot:snapshot=>{if(session!==current)return;current.latestSnapshot=snapshot;scheduleAutosave(current,snapshot);},
      onStatus:status=>{
        if(session!==current)return;
        if(status.level==='error'){$('#runtime-status').textContent=status.message;$('#runtime-status').hidden=false;$('#save-status').textContent='Runtime needs attention';}
        if(status.level==='ready'){$('#save-now').disabled=false;$('#debug-choices').disabled=false;$('#save-status').textContent=settings.autosaveLimit?'Autosave ready':'Autosave off';}
      }
    });
  }catch(error){await leavePlayer(false);throw error;}
  finally{launching=false;$('#leave-player').disabled=false;}
}
function saveFingerprint(snapshot,values={},ignorePosition=false) {
  // The engine mirrors its current page and stats/backup copies into Persist.
  // The portable state already represents that progress. Keep the full storage
  // in saved records, but don't create history entries for those cache writes.
  const state=copy(snapshot.state);
  delete state.version;
  if(ignorePosition){delete state.lineNum;delete state.indent;}
  if(state.temps)delete state.temps.choice_user_restored;
  const meaningfulStorage=Object.fromEntries(Object.entries(values).filter(([key])=>!/^persist:.*:(?:state|statetemp|statebackup)$/.test(key)));
  // Key order can change through native JSON storage. Metadata such as capture
  // time, previews and recovery checkpoints doesn't constitute new progress.
  return JSON.stringify({state,storage:meaningfulStorage},(_,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
}
function scheduleAutosave(current,snapshot){
  clearTimeout(autoTimer);
  if(settings.autosaveLimit>0)autoTimer=setTimeout(()=>{if(session===current)enqueueSave(snapshot,'auto').catch(report);},650);
}
function enqueueSave(snapshot,kind='auto',name) {
  const current=session;if(!current)return Promise.resolve();
  if(kind==='auto'&&settings.autosaveLimit===0)return Promise.resolve();
  const savedStorage=copy(storage);
  saveQueue=saveQueue.catch(()=>{}).then(async()=>{
    if(kind==='auto'&&settings.autosaveLimit===0)return;
    if(!snapshot?.state||!snapshot?.scene?.name)throw new Error('This game has no restorable state yet.');
    const fingerprint=saveFingerprint(snapshot,savedStorage);
    const changeFingerprint=saveFingerprint(snapshot,savedStorage,true);
    if(kind==='auto'&&fingerprint===current.lastFingerprint)return;
    if(kind==='auto'&&!settings.saveContinuations&&snapshot.transition==='continue'&&changeFingerprint===current.lastChangeFingerprint)return;
    const record={id:uid(),gameId:current.game.id,versionId:current.version.id,name:name||`Autosave · ${snapshot.scene.name}`,kind,createdAt:new Date().toISOString(),runId:current.runId,snapshot:copy(snapshot),storage:savedStorage};
    if(!await db.putSave(record))return;
    current.lastFingerprint=fingerprint;
    current.lastChangeFingerprint=changeFingerprint;
    if(session===current)$('#save-status').textContent=`Saved ${new Date().toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}`;
  });
  return saveQueue;
}
async function flush() {
  clearTimeout(autoTimer);
  if(runtime&&session&&settings.autosaveLimit>0){const snapshot=await runtime.capture();await enqueueSave(snapshot,'auto');}
  await saveQueue;
}
async function leavePlayer(capture=true) {
  if(capture)await flush();
  clearTimeout(autoTimer);runtime?.dispose();runtime=null;session=null;
  closeMenus();
  $('#player').hidden=true;$('#runtime').replaceChildren();document.body.style.overflow='';await refresh();
}
async function toggleChoiceDebug() {
  const player=runtime,current=session;if(!player||!current)return;
  const button=$('#debug-choices');button.disabled=true;
  try{
    const result=await player.setDebugMode(!debugChoices);
    if(session!==current)return;
    debugChoices=result.enabled;button.setAttribute('aria-pressed',String(debugChoices));closeMenus(true);
  }catch(error){if(session===current){$('#runtime-status').textContent=error.message;$('#runtime-status').hidden=false;}}
  finally{if(session===current)button.disabled=false;}
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
  const mime='application/zip';
  if(window.VaultNative?.exportFile){await window.VaultNative.exportFile({name,data:bytesToBase64(value),mime,encoding:'base64'});return;}
  const blob=new Blob([value],{type:mime});
  const file=new File([blob],name,{type:mime});
  if(navigator.canShare?.({files:[file]})&&navigator.share){try{await navigator.share({files:[file],title:name});return;}catch(error){if(error.name==='AbortError')return;}}
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function importSave(file){
  const envelope=await readSaveFile(file);
  const game=games.find(g=>g.id===selected);if(!game)throw new Error('Import the matching game first.');
  if(envelope.format!=='story-vault-save'){
    if(envelope.format==='story-vault-backup')throw new Error('Use Restore backup to import a complete library.');
    return previewLegacyImport(envelope,game);
  }
  if(envelope.version!==2)throw new Error('This PathOS save file uses an unsupported format version.');
  const contentHash=envelope.source?.contentHash, source=versions.find(v=>v.gameId===game.id&&!v.removed&&v.contentHash===contentHash);
  if(!source)throw new Error('The game version that created this save isn’t installed for the selected game. Install that version first so the save can be verified.');
  const record={...envelope.save,id:uid(),gameId:game.id,versionId:source.id,createdAt:new Date().toISOString(),name:(envelope.save.name||'Imported save')+' (imported)'};
  validateSaveRecord(record);await db.putSave(record);await refresh();notify('Save imported into the selected game.');
}
function previewLegacyImport(envelope,game){
  const installed=versions.filter(v=>v.gameId===game.id&&!v.removed);
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
function help(){modal(`<h2>Your games, kept together</h2><p>Import an APK that contains a complete ChoiceScript web game, or a ZIP of a playable ChoiceScript folder. Bundled APK content stays available through local purchase checks. Android code, store billing, and chapters that download after installation won’t work here.</p><ol><li>Import a game and start playing. Automatic snapshots keep your recent positions; named snapshots stay until you delete them.</li><li>When a game gets an update, import the new APK and choose the same game under “Library.” This works even if the update’s detected game ID has changed.</li><li>All saves appear in one list. When you resume, PathOS checks the saved chapter against the version you picked. If the save can’t continue there, you can still play it on its original version.</li><li>Use Edit to make a modified copy. Export a single save or a full backup to move between browsers and the iOS app.</li></ol><p>${db.storageKind==='native'?'Your library is saved in the app’s durable device storage. It stays through app updates, but deleting the app deletes its local data.':'Your library is stored in this browser, for this site address only. Keep using the same address so it carries over to new releases.'} The browser and iOS app keep separate libraries and don’t sync. Backups include the imported game files, so keep them private.</p>${isIOSWeb()?iosHomeScreenHelp():''}<p>Export a backup to Files or iCloud Drive to protect against losing your device or deleting local data.</p><div class="modal-actions"><button id="help-restore" class="secondary">Restore backup</button><button data-close class="primary">Done</button></div>`,()=>{$('#help-restore').onclick=()=>{$('#modal').close();$('#backup-file').click();};});}

$('#import').onclick=()=>{delete $('#archive-file').dataset.target;$('#archive-file').click();};
$('#archive-file').onchange=event=>{const file=event.target.files[0];if(file)importArchive(file,event.target.dataset.target).catch(report);event.target.value='';};
$('#save-file').onchange=event=>{const file=event.target.files[0];if(file)importSave(file).catch(report);event.target.value='';};
$('#backup').onclick=async()=>{try{if(runtime)await flush();notify('Compressing games, versions, and saves…');await exportFile('PathOS-Backup-'+new Date().toISOString().slice(0,10)+'.pathos-backup.zip',await db.exportBackup());notify('Backup ready. Keep a copy somewhere outside PathOS.');}catch(e){report(e);}};
$('#restore-backup').onclick=()=>$('#backup-file').click();
$('#backup-file').onchange=async event=>{const file=event.target.files[0];event.target.value='';if(!file)return;try{
  const backup=await decodeBackup(file);
  modal(`<h2>Restore a library backup</h2><p>This adds ${esc(backup.games.length)} games and ${esc(backup.saves.length)} saves to the library on this device. PathOS checks for conflicts before changing anything.</p><div class="modal-error" id="restore-error"></div><div class="modal-actions"><button data-close>Cancel</button><button id="restore-confirm" class="primary">Restore backup</button></div>`,()=>{$('#restore-confirm').onclick=async()=>{try{$('#restore-confirm').disabled=true;await db.restoreRecords(backup);settings=await db.getSettings();await applySettings();$('#modal').close();await refresh();notify('Backup restored. Games and saves are available on this device.');}catch(e){$('#restore-error').textContent=e.message;$('#restore-confirm').disabled=false;}};});
}catch(e){report(e);}};
$('#search').oninput=render;$('#help').onclick=help;$('#save-now').onclick=manualSave;
$('#debug-choices').onclick=toggleChoiceDebug;
$('#settings').onclick=openSettings;$('#reader-settings').onclick=openSettings;
for(const [triggerId,panelId] of disclosures)$('#'+triggerId).onclick=()=>toggleMenu(triggerId,panelId);
$('#main-menu').addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||button.disabled)return;
  closeMenus(true);
  if(button.dataset.trigger){
    if(button.id==='menu-import-save'){selectingSaves=false;selectedSaves.clear();render();}
    $('#'+button.dataset.trigger).click();
  }
});
document.addEventListener('click',event=>{if(!event.target.closest('.topbar,.player-toolbar'))closeMenus();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&disclosures.some(([id])=>$('#'+id).getAttribute('aria-expanded')==='true')){event.preventDefault();closeMenus(true);}});
$('#leave-player').onclick=()=>leavePlayer().catch(error=>{modal(`<h2>No new snapshot was saved</h2><p>${esc(error.message)}</p><p>Wait for the game to finish loading and try again, or return to the library. Your existing snapshots are safe.</p><div class="modal-actions"><button data-close>Keep playing</button><button id="leave-without-save" class="primary">Return to library</button></div>`,()=>{$('#leave-without-save').onclick=()=>{$('#modal').close();leavePlayer(false).catch(report);};});});
$('#storage-info').onclick=()=>showStorageInfo().catch(report);
async function exploreDemo(){try{const file=await createDemoArchive();await importArchive(file);}catch(e){report(e);}}
$('#demo').onclick=exploreDemo;
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flush().catch(report);});
document.addEventListener('vault-native-pause',()=>flush().catch(report).finally(()=>window.VaultNative?.storage?.({operation:'backgroundSaveFinished'}).catch(report)));
window.addEventListener('pagehide',()=>{flush().catch(()=>{});});

systemTheme?.addEventListener?.('change',()=>applySettings().catch(report));
try{db=await openVault();settings=await db.getSettings();await applySettings();await db.compactSaves();setupStorageHelp();await refresh();if('serviceWorker' in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./sw.js').catch(error=>console.warn('Offline shell unavailable',error));}catch(error){report(error);$('#import').disabled=true;}
