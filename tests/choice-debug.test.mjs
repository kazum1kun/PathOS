import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { inspectChoiceBlock } from '../src/choice-debug.js';

function scene(source, values = {}, temps = {}) {
  return {
    lines: source.split('\n'), lineNum: 0, indent: 0, stats: { strength: 10 }, temps: { choice_reuse: 'allow', ...temps },
    getIndent(line) { this.lastIndentCheck = this.lineNum; return /^\s*/.exec(line)[0].length; },
    tokenizeExpr(expression) { return expression; },
    evaluateExpr(expression) { this.temps.evaluated = true; if (Object.hasOwn(values, expression)) return values[expression]; throw new Error('Unknown variable'); },
    replaceVariables(text) { return text.replace('${strength}', this.stats.strength); },
  };
}
function rendered(source, name, extra = {}) { return { name, line: source.lines.findIndex(line => line.endsWith('#' + name)) + 1, ...extra }; }

test('choice inspector reveals inline, nested and reused options without mutating the live scene', () => {
  const s = scene(`*choice
  *if (strong) #Lift the gate.
    *finish
  *if trained
    *selectable_if (ready) #Enter the contest.
      *finish
  *elseif lucky
    #Try your luck.
      *finish
  *else
    #Walk away.
      *finish
  *hide_reuse #Ask again.
    *finish
  *disable_reuse #Visit again.
    *finish
  #Rest.
    *finish
Afterwards.`, { strong: false, trained: true, ready: false, lucky: true });
  s.temps.choice_used = { 12: 1, 14: 1 };
  const existing = [rendered(s, 'Enter the contest.', { unselectable: true }), rendered(s, 'Visit again.', { unselectable: true }), rendered(s, 'Rest.')];
  const before = structuredClone({ stats: s.stats, temps: s.temps, lineNum: s.lineNum, indent: s.indent });
  const result = inspectChoiceBlock(s, 0, [''], existing);
  assert.deepEqual(result.options.map(entry => [entry.name, entry.availability]), [
    ['Lift the gate.', 'hidden'], ['Enter the contest.', 'disabled'], ['Try your luck.', 'hidden'], ['Walk away.', 'hidden'], ['Ask again.', 'hidden'], ['Visit again.', 'disabled'], ['Rest.', 'available'],
  ]);
  assert.deepEqual(result.options[1].conditions.map(item => [item.kind, item.expression, item.result]), [['if', 'trained', true], ['selectable_if', 'ready', false]]);
  assert.equal(result.options[2].conditions[0].result, false, 'elseif is unavailable when an earlier branch passed');
  assert.equal(result.options[3].conditions[0].result, false, 'else requires all earlier branches to fail');
  assert.equal(result.options[4].conditions[0].kind, 'hide_reuse');
  assert.equal(result.options[4].conditions[0].result, false);
  assert.equal(result.options[0].option.line, 2, 'synthesized option uses the engine body pointer');
  assert.equal(result.options.at(-1).option, existing.at(-1), 'real option objects are retained');
  assert.equal(result.choiceEnd, 17);
  assert.deepEqual({ stats: s.stats, temps: s.temps, lineNum: s.lineNum, indent: s.indent }, before);
  assert.equal(s.lastIndentCheck, undefined, 'even engine indentation bookkeeping is isolated');
});

test('choice inspector handles group paths, quoted parentheses and unknown conditions', () => {
  const s = scene(`*choice color toy
  *if (label = "a)b") #Red
    *selectable_if (unknown) #Boat
      *finish
  #Blue
    #Boat
      *finish`, { 'label = "a)b"': false });
  const blue = { name: 'Blue', line: 5, suboptions: [{ name: 'Boat', line: 6 }] };
  const result = inspectChoiceBlock(s, 0, ['color', 'toy'], [blue]);
  assert.equal(result.options[0].availability, 'hidden');
  assert.equal(result.options[0].children[0].conditions[0].expression, 'label = "a)b"');
  assert.equal(result.options[0].children[0].conditions[1].result, null);
  assert.equal(result.options[1].children[0].availability, 'available');
  assert.equal(result.options[1].children[0].option, blue.suboptions[0]);
});

test('unknown syntax retains rendered choices and does not inspect conditionals inside option bodies', () => {
  const s = scene(`*fake_choice
  #Ordinary
    *if secret
      Some story text.
  *script generatedChoice()
Done.`);
  const dynamic = { name: '<img src=x onerror=alert(1)>', line: 5 };
  const result = inspectChoiceBlock(s, 0, [''], [{ name: 'Ordinary', line: 2 }, dynamic]);
  assert.equal(result.options.length, 2);
  assert.equal(result.options[0].conditions.length, 0);
  assert.equal(result.options[1].option, dynamic);
  assert.ok(result.notes.length);
  const commented=scene('*choice\n  *comment These options stay inspectable.\n    *if (missing) #Hidden\n      *finish\n  #Normal\n    *finish');
  assert.equal(inspectChoiceBlock(commented,0,[''],[{name:'Normal',line:6}]).options[0].name,'Hidden','comment indentation must not swallow option source');
});

function effectScene(source) {
  const s = scene(source);
  s.stats = { strength: 10, ready: false, label: 'before' };
  s.temps.ready = true;
  s.getVar = function(name) { return Object.hasOwn(this.temps, name) ? this.temps[name] : this.stats[name]; };
  const expressions = {
    'strength >= 50': function() { return this.getVar('strength') >= 50; },
    'strength > 12': function() { return this.getVar('strength') > 12; },
    'strength + 5': function() { return this.getVar('strength') + 5; },
    'strength - 3': function() { return this.getVar('strength') - 3; },
    'strength %+ 20': function() { const value = this.getVar('strength'); return Math.floor(value + (100 - value) * .2); },
    'ready': function() { return this.getVar('ready'); },
    'not ready': function() { return !this.getVar('ready'); },
    'true': () => true, '7': () => 7, '"<b>after</b>"': () => '<b>after</b>',
  };
  s.evaluateExpr = function(expression) { if (!Object.hasOwn(expressions, expression)) throw new Error('Unknown expression'); return expressions[expression].call(this); };
  return s;
}

test('effects preview tracks sequential changes, temp scope, fairmath and branches on independent copies', () => {
  const s = effectScene(`*fake_choice
  *if (strength >= 50) #Train
    *set strength + 5
    *if strength > 12
      *set strength - 3
    *elseif ready
      *set strength 7
    *else
      *set strength 7
    *set strength %+ 20
    *temp ready not ready
    *temp unused
    *set label "<b>after</b>"
    *goto_scene chapter2
    *set strength 7
  #Wait
    *set strength + 5
    *set ready not ready
  #Read
    Just some story text.
Afterwards.`);
  const before = JSON.stringify({ stats: s.stats, temps: s.temps, line: s.lineNum });
  const result = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Wait'), rendered(s, 'Read')]);
  assert.deepEqual(result.options[0].conditions[0].values, [{ name: 'strength', scope: 'stats', value: 10 }]);
  assert.deepEqual(result.options[0].effects.filter(item => item.kind !== 'flow').map(item => [item.scope, item.name, item.before, item.after]), [
    ['stats', 'strength', 10, 15], ['stats', 'strength', 15, 12], ['stats', 'strength', 12, 29],
    ['temps', 'ready', true, false], ['temps', 'unused', undefined, null], ['stats', 'label', 'before', '<b>after</b>'],
  ]);
  assert.equal(result.options[0].effects.at(-1).source, '*goto_scene chapter2');
  assert.match(result.options[0].effectNotes.join(' '), /stops here/);
  assert.deepEqual(result.options[1].effects.map(item => [item.name, item.before, item.after]), [['strength', 10, 15], ['ready', true, false]], 'each option starts from current state and temps take priority');
  assert.deepEqual(result.options[2].effects, []);
  assert.deepEqual(result.options[2].effectNotes, []);
  assert.equal(JSON.stringify({ stats: s.stats, temps: s.temps, line: s.lineNum }), before);
  assert.equal(s.lastIndentCheck, undefined);
});

test('effect prediction stops before unknown, random, scripted, input and called code', () => {
  for (const command of ['*if unknown\n      *set strength 7', '*rand strength 1 100', '*script throw new Error("Must never execute")', '*input_number strength 1 100', '*gosub reward', '*set {dynamic} 7', '*set strength missing', '*unknown_effect']) {
    const s = effectScene(`*choice\n  #Test\n    *set strength + 5\n    ${command}\n    *set strength - 3\n  #Other\n    *finish`);
    s.script = () => assert.fail('Option commands must never execute');
    const { options } = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Test'), rendered(s, 'Other')]);
    assert.deepEqual(options[0].effects.filter(item => item.kind === 'set').map(item => item.after), [15], command);
    assert.ok(options[0].effectNotes.length, command);
    assert.equal(s.stats.strength, 10);
  }
});

test('effect preview follows only the selected branch and caps large bodies', () => {
  const s = effectScene(`*choice
  #Test
    *if ready
      *set strength 7
    *elseif unknown
      *script never()
    *else
      *script never()
    *if not ready
      *script never()
    *else
      *set label "<b>after</b>"
  #Large
${Array(250).fill('    *set strength + 5').join('\n')}`);
  const { options } = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Test'), rendered(s, 'Large')]);
  assert.deepEqual(options[0].effects.map(item => item.after), [7, '<b>after</b>']);
  assert.deepEqual(options[0].effectNotes, []);
  assert.equal(options[1].effects.length, 40);
  assert.match(options[1].effectNotes.join(' '), /limit reached/);
});

test('supplied APK parser and resolution support inspecting and forcing a hidden fake-choice branch', {skip:!process.env.PATHOS_APK_SCENE || !process.env.PATHOS_APK_HTML}, async()=>{
  const context=vm.createContext({console,printFooter(){}});
  vm.runInContext(await readFile(process.env.PATHOS_APK_HTML,'utf8'),context);
  vm.runInContext(await readFile(process.env.PATHOS_APK_SCENE,'utf8'),context);
  const s=new context.Scene('debug-test',{strength:10,ready:false,picked:''});
  s.lines=`*fake_choice
  *if (strength >= 50) #Lift the gate.
    *set picked "hidden"
  *selectable_if (ready) #Join the guard.
    *set picked "disabled"
  #Wait.
    *set picked "normal"
*abort`.split('\n');
  s.paragraph=()=>{};s.save=()=>{};s.resetPage=()=>s.printLoop();
  let rendered;
  s.renderOptions=(_groups,options)=>{rendered=options;};
  s.fake_choice('');
  assert.deepEqual(Array.from(rendered,option=>[option.name,!!option.unselectable]),[['Join the guard.',true],['Wait.',false]]);
  const before=context.computeCookie(s.stats,s.temps,s.lineNum,s.indent);
  const model=inspectChoiceBlock(s,0,[''],rendered);
  assert.equal(context.computeCookie(s.stats,s.temps,s.lineNum,s.indent),before);
  assert.equal(model.options[0].conditions[0].result,false);
  for(const line of model.boundaries)s.temps._choiceEnds[line]=model.choiceEnd;
  s.standardResolution(model.options[0].option);
  assert.equal(s.stats.picked,'hidden','actual engine resolves the hidden body and skips other fake-choice branches');
  assert.equal(s.stats.strength,10);
});
