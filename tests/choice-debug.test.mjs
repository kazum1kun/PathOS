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
