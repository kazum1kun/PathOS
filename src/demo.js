// Original, tiny demo used to exercise the library without distributing a game.
export async function createDemoArchive() {
  const scenes={
    startup:{crc:104,lines:['*title The Lighthouse','*author PathOS','*create courage 50','*create supplies 3','*create name "Keeper"','You reach a lighthouse as the last light leaves the sea.','*choice','  #Climb the tower.','  #Search the shore.','  *if (courage >= 60) #Take the cliff path.','  *selectable_if (supplies >= 5) #Hire a guide.'],labels:{}},
    tower:{crc:105,lines:['The lamp has gone dark. A fishing boat pitches beyond the reef.','*choice','  *selectable_if (supplies > 0) #Use a supply to light the lamp.','  #Signal from the balcony.'],labels:{}},
    ending:{crc:103,lines:['A bell answers from the water. The boat turns safely toward the harbor.','The light holds until morning.'],labels:{}}
  };
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>The Lighthouse</title><style>body{background:#fbf8f1;color:#1e1b16;font:18px/1.9 Georgia,serif;max-width:650px;margin:40px auto;padding:24px}h1{font-size:34px;font-weight:normal}button{display:block;width:100%;background:#fff;border:1px solid #c2b7a2;border-radius:3px;padding:15px;text-align:left;font:16px Georgia,serif;color:#1e1b16;cursor:pointer;margin:12px 0}small{font:12px sans-serif;color:#877f71}.stats{font:13px sans-serif;border-top:1px solid #ddd4c3;margin-top:30px;padding-top:18px}</style><script>window.storeName="pathos-lighthouse-demo";window.allScenes=${JSON.stringify(scenes)};</script><script>
  var stats;
  function Scene(name,stats){this.name=name;this.stats=stats;this.temps={};this.lineNum=0;this.indent=0;this.lines=allScenes[name].lines;this.labels={};this.crc=allScenes[name].crc;stats.sceneName=name;stats.scene=this;}
  Scene.prototype.printLoop=function(){
    var scene=this,root=document.getElementById('story');root.textContent='';
    var title=document.createElement('h1');title.textContent='The Lighthouse';root.append(title);
    var hint=document.createElement('small');hint.textContent='An original demo · '+scene.name;root.append(hint);
    var p=document.createElement('p');p.textContent=scene.name==='startup'?allScenes.startup.lines[5]:allScenes[scene.name].lines[0];root.append(p);
    if(scene.name!=='ending'){scene.lineNum=scene.name==='startup'?6:1;scene.choice();}
    else{var end=document.createElement('p');end.textContent='The light holds until morning. Your path is complete. Return to the library to try a different choice.';root.append(end);}
    var summary=document.createElement('div');summary.className='stats';summary.textContent=stats.name+' · Courage '+stats.courage+' · Supplies '+stats.supplies;root.append(summary);
  };
  Scene.prototype.getIndent=function(line){return /^\\s*/.exec(line||'')[0].length;};
  Scene.prototype.tokenizeExpr=function(expression){return expression;};
  Scene.prototype.evaluateExpr=function(expression){var match=/^(\\w+)\\s*(>=|>)\\s*(\\d+)$/.exec(expression);if(!match)throw new Error('Unknown demo condition');return match[2]==='>'?this.stats[match[1]]>Number(match[3]):this.stats[match[1]]>=Number(match[3]);};
  Scene.prototype.replaceVariables=function(text){return text;};
  Scene.prototype.choice=function(){var scene=this,options=[];scene.lines.forEach(function(line,index){var match=/#(.+)$/.exec(line);if(!match)return;var condition=/^\\s*\\*(if|selectable_if) \\((.*?)\\)/.exec(line),allowed=!condition||scene.evaluateExpr(condition[2]);if(condition&&condition[1]==='if'&&!allowed)return;options.push({name:match[1],line:index+1,unselectable:!allowed});});scene.renderOptions([''],options,function(option){if(scene.name==='startup'){stats.courage+=option.line===8?5:option.line===10?10:-5;if(option.line===9)stats.supplies++;if(option.line===11)stats.supplies-=5;new Scene('tower',stats).printLoop();}else{if(option.line===3)stats.supplies=Math.max(0,stats.supplies-1);new Scene('ending',stats).printLoop();}});};
  Scene.prototype.renderOptions=function(groups,options,callback){var form=document.createElement('form');options.forEach(function(option){var button=document.createElement('button');button.type='button';button.textContent=option.name;button.disabled=!!option.unselectable;button.onclick=function(){callback(option);};form.append(button);});document.getElementById('story').append(form);};
  function computeCookie(s,t,line,indent){var clean={};Object.keys(s).forEach(function(k){if(k!=='scene')clean[k]=s[k];});return JSON.stringify({version:'demo-1',stats:clean,temps:t,lineNum:line,indent:indent});}
  function clearScreen(callback){document.getElementById('story').textContent='';callback();}
  function restoreGame(state){stats=state.stats;var scene=new Scene(stats.sceneName||'startup',stats);scene.lineNum=state.lineNum||0;scene.indent=state.indent||0;scene.temps=state.temps||{};scene.printLoop();}
  window.onload=function(){var store=new Persist.Store(window.storeName);store.get('state',function(ok,value){if(value){restoreGame(JSON.parse(value));}else{stats={name:'Keeper',courage:50,supplies:3};new Scene('startup',stats).printLoop();}});};
  </script></head><body><main id="story"></main></body></html>`;
  const zip=new globalThis.JSZip();zip.file('index.html',html);
  return new File([await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})],'The-Lighthouse-Demo.zip',{type:'application/zip'});
}
