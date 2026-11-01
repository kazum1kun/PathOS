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

const upstreamSources = Promise.all(['util.js', 'scene.js'].map(name => readFile(new URL(`./fixtures/choicescript/${name}`, import.meta.url), 'utf8')));
async function upstreamScene(source, stats = {}) {
  let randomCalls = 0;
  const math = Object.assign(Object.create(Math), { random() { randomCalls++; return 0; } });
  const context = vm.createContext({ console, Math: math, trackEvent() {}, printFooter() {} });
  for (const script of await upstreamSources) vm.runInContext(script, context);
  const s = new context.Scene('debug-test', stats);
  s.lines = source.split('\n'); s.paragraph = () => {}; s.save = () => {};
  s.resetPage = () => s.printLoop(); s.finish = () => { s.finished = true; };
  let options;
  s.renderOptions = (_groups, parsed) => { options = parsed; };
  s.choice('');
  return { s, options, randomCalls: () => randomCalls };
}

test('upstream boolean strings retain known results for inline, selectable and block conditions', async () => {
  for (const flag of ['true', 'false', true, false]) {
    const { s, options } = await upstreamScene(`*choice
  *if (flag) #Inline
    *finish
  *selectable_if (flag) #Selectable
    *finish
  *if flag
    #Block
      *finish
  *else
    #Alternative
      *finish
  #Other
    *finish`, { flag });
    const truth = flag === true || flag === 'true', inspected = inspectChoiceBlock(s, 0, [''], options).options;
    for (const name of ['Inline', 'Selectable', 'Block']) assert.equal(inspected.find(entry => entry.name === name).conditions[0].result, truth, `${name}: ${flag}`);
    assert.equal(inspected.find(entry => entry.name === 'Alternative').conditions[0].result, !truth);
    assert.equal(inspected.find(entry => entry.name === 'Selectable').availability, truth ? 'available' : 'disabled');
    assert.equal(inspected.find(entry => entry.name === 'Inline').availability, truth ? 'available' : 'hidden');
  }
});

test('effect branches using upstream boolean strings match execution', async () => {
  const { s, options } = await upstreamScene(`*choice
  #Test
    *temp enabled "true"
    *if enabled
      *set score 7
    *temp disabled "false"
    *if disabled
      *set score 99
    *else
      *set score +1
    *finish`, { score: 0 });
  const effects = inspectChoiceBlock(s, 0, [''], options).options[0].effects;
  assert.deepEqual(effects.filter(effect => effect.kind === 'set').map(effect => effect.after), ['7', 8]);
  assert.ok(effects.every(effect => effect.kind !== 'unknown'));
  s.standardResolution(options[0]);
  assert.equal(s.stats.score, effects.filter(effect => effect.kind === 'set').at(-1).after);
});

test('equal upstream random bounds preserve the original minimum representation', async () => {
  for (const [bounds, values] of [['1.0 1.0', {}], ['"01" "01"', {}], ['1 1', {}], ['low high', { low: '1.0', high: 1 }]]) {
    const { s, options, randomCalls } = await upstreamScene(`*choice
  #Test
    *rand roll ${bounds}
    *set score length(roll)
    *finish`, { roll: 0, score: 0, ...values });
    const effects = inspectChoiceBlock(s, 0, [''], options).options[0].effects;
    assert.equal(randomCalls(), 0);
    s.standardResolution(options[0]);
    assert.equal(effects.find(effect => effect.kind === 'set').after, s.stats.score, bounds);
    assert.equal(randomCalls(), 0, 'equal bounds do not draw a random number');
  }
});

test('equal random bounds stay known when another world exceeds the expansion budget', async () => {
  const { s, options, randomCalls } = await upstreamScene(`*choice
  #Test
    *rand side 1 2
    *if side = 1
      *set low 1.0
      *set high 1.0
    *else
      *set low 1
      *set high 1000
    *rand roll low high
    *if side = 1
      *set score length(roll)
    *finish`, { side: 0, low: 0, high: 0, roll: 0, score: 0, implicit_control_flow: true });
  const effects = inspectChoiceBlock(s, 0, [''], options).options[0].effects;
  const score = effects.find(effect => effect.kind === 'set' && effect.name === 'score');
  assert.equal(score.after, 3);
  assert.equal(score.afterUnknown, false);
  assert.equal(score.chance, .5);
  assert.equal(randomCalls(), 0);
  s.standardResolution(options[0]);
  assert.equal(s.stats.score, score.after);
});

test('upstream function names are not mistaken for uncertain variable reads', async () => {
  const { s, options, randomCalls } = await upstreamScene(`*choice
  #Test
    *rand round 1 1000
    *set score round(2.4)
    *set score +1
    *finish`, { round: 0, score: 0 });
  const effects = inspectChoiceBlock(s, 0, [''], options).options[0].effects;
  assert.deepEqual(effects.filter(effect => effect.kind === 'set').map(effect => [effect.after, effect.afterUnknown]), [[2, false], [3, false]]);
  assert.equal(randomCalls(), 0);
  s.standardResolution(options[0]);
  assert.equal(s.stats.score, 3);
});

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
    'roll <= 2': function() { return this.getVar('roll') <= 2; },
    'roll = other': function() { return this.getVar('roll') === this.getVar('other'); },
    'roll > 50': function() { return this.getVar('roll') > 50; },
    'strength + roll': function() { return this.getVar('strength') + this.getVar('roll'); },
    'roll + 1': function() { return this.getVar('roll') + 1; },
    '(strength - 3)': function() { return this.getVar('strength') - 3; },
    'true': () => true, '7': () => 7, '"<b>after</b>"': () => '<b>after</b>',
  };
  s.evaluateExpr = function(expression) {
    if (/^-?\d+(?:\.\d+)?$/.test(expression)) return Number(expression);
    if (Object.hasOwn(this.temps, expression) || Object.hasOwn(this.stats, expression)) return this.getVar(expression);
    if (!Object.hasOwn(expressions, expression)) throw new Error('Unknown expression'); return expressions[expression].call(this);
  };
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
  assert.equal(result.options[0].effects.at(-1).command, 'goto_scene');
  assert.equal(result.options[0].effects.at(-1).destination, 'chapter2');
  assert.deepEqual(result.options[0].effectNotes, ['Chapter source unavailable: chapter2.']);
  assert.deepEqual(result.options[1].effects.map(item => [item.name, item.before, item.after]), [['strength', 10, 15], ['ready', true, false]], 'each option starts from current state and temps take priority');
  assert.deepEqual(result.options[2].effects, []);
  assert.deepEqual(result.options[2].effectNotes, []);
  assert.equal(JSON.stringify({ stats: s.stats, temps: s.temps, line: s.lineNum }), before);
  assert.equal(s.lastIndentCheck, undefined);
});

test('effect prediction identifies unknown, scripted, input and called code without verbose stop notices', () => {
  for (const command of ['*if unknown\n      *set strength 7', '*script throw new Error("Must never execute")', '*input_number strength 1 100', '*gosub reward', '*set {dynamic} 7', '*set strength missing', '*unknown_effect']) {
    const s = effectScene(`*choice\n  #Test\n    *set strength + 5\n    ${command}\n    *set strength - 3\n  #Other\n    *finish`);
    s.script = () => assert.fail('Option commands must never execute');
    const { options } = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Test'), rendered(s, 'Other')]);
    assert.deepEqual(options[0].effects.filter(item => item.kind === 'set').map(item => item.after), [15], command);
    assert.ok(['unknown', 'flow'].includes(options[0].effects.at(-1).kind), command);
    assert.deepEqual(options[0].effectNotes, [], command);
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
  assert.deepEqual(options[1].effectNotes, ['More effects.']);
});

test('random integer effects enumerate dependent changes and branch probabilities without drawing a roll', () => {
  const s = effectScene(`*choice
  #Roll
    *rand roll 1 6
    *if roll <= 2
      *set strength + 5
    *else
      *set strength - 3
    *set strength + roll
  #Wait
    *set strength + 5`);
  s.stats.roll = 0;
  s.rand = () => assert.fail('Preview must not execute rand');
  const before = JSON.stringify({ stats: s.stats, temps: s.temps }), originalRandom = Math.random;
  let result;
  try {
    Math.random = () => assert.fail('Preview must not consume randomness');
    result = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Roll'), rendered(s, 'Wait')]);
  } finally { Math.random = originalRandom; }
  const effects = result.options[0].effects;
  assert.deepEqual(effects[0].ranges, [{ min: 1, max: 6, integer: true }]);
  assert.equal(effects[0].chance, 1);
  assert.ok(Math.abs(effects[1].chance - 1 / 3) < 1e-9);
  assert.deepEqual(effects[1].afterValues, [15]);
  assert.ok(Math.abs(effects[2].chance - 2 / 3) < 1e-9);
  assert.deepEqual(effects[2].afterValues, [7]);
  assert.deepEqual(effects[3].afterValues, [16, 17, 10, 11, 12, 13]);
  assert.equal(effects[3].chance, 1);
  assert.equal(result.options[1].effects[0].before, 10, 'other choices keep their independent initial state');
  assert.equal(JSON.stringify({ stats: s.stats, temps: s.temps }), before);
});

test('successive rolls preserve independence, copied rolls retain correlation, and grouped bounds parse', () => {
  for (const copied of [false, true]) {
    const s = effectScene(`*choice\n  #Roll\n    *rand roll 1 2\n    ${copied ? '*set other roll' : '*rand other 1 2'}\n    *if roll = other\n      *set strength + 5`);
    s.stats.roll = 0; s.stats.other = 0;
    const { options } = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Roll')]);
    assert.equal(options[0].effects.at(-1).chance, copied ? 1 : .5);
  }
  const s = effectScene('*choice\n  #Roll\n    *rand strength (strength - 3) strength');
  const { options } = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Roll')]);
  assert.deepEqual(options[0].effects[0].ranges, [{ min: 7, max: 10, integer: true }]);
});

test('continuous and large random ranges remain ranges while independent changes still parse', () => {
  for (const [bounds, expected] of [
    ['1.0 6.0', { min: 1, max: 6, integer: false }],
    ['1.25 7.5', { min: 1.25, max: 7.5, integer: false }],
    ['1 1000', { min: 1, max: 1000, integer: true }],
  ]) {
    const s = effectScene(`*choice\n  #Roll\n    *rand roll ${bounds}\n    *set strength 7\n    *set roll + 1\n    *if roll > 50\n      *set strength + 5`);
    s.stats.roll = 0;
    const { options } = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Roll')]);
    assert.deepEqual(options[0].effects[0].ranges, [expected]);
    assert.equal(options[0].effects[1].after, 7);
    assert.equal(options[0].effects[2].afterUnknown, true);
    assert.equal(options[0].effects[3].description, 'Conditional effects.');
    assert.equal(s.stats.roll, 0);
    assert.equal(s.stats.strength, 10);
  }
});

test('invalid random arguments and branching expansion are bounded without reporting guessed effects', () => {
  for (const bounds of ['6 1', 'missing 6', '1', '1 2 extra']) {
    const s = effectScene(`*choice\n  #Roll\n    *rand strength ${bounds}\n    *set strength + 5`);
    const { options } = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Roll')]);
    assert.equal(options[0].effects.length, 1);
    assert.equal(options[0].effects[0].description, 'Random effect.');
  }
  const s = effectScene('*choice\n  #Roll\n    *rand roll 1 100\n    *rand other 1 100\n    *set strength 7\n    *if roll = other\n      *set strength + 5');
  s.stats.roll = 0; s.stats.other = 0;
  const { options } = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Roll')]);
  assert.deepEqual(options[0].effects.map(effect => effect.kind), ['rand', 'rand', 'set', 'unknown']);
  assert.equal(options[0].effects[2].chance, 1);
  const branching = effectScene('*choice\n  #Roll\n    *rand roll 1 100\n    *if roll > 50\n      *rand other 1 2\n    *if roll = other\n      *set strength + 5');
  branching.stats.roll = 0; branching.stats.other = 0;
  const bounded = inspectChoiceBlock(branching, 0, [''], [rendered(branching, 'Roll')]);
  assert.equal(bounded.options[0].effects.at(-1).kind, 'unknown', 'separate conditional branches share the same outcome budget');
});

test('lookahead follows jumps out of conditionals, page breaks and cosmetic fake choices to the next decision', () => {
  const s = effectScene(`*choice
  #Test
    *if ready
      *set strength + 5
      *goto reward
    *set strength 7
  #Wait
    *finish
*label reward
*page_break Next
*set strength - 3
*fake_choice
  #Speak
    A greeting.
  #Nod
    A quiet nod.
*set strength + 5
*choice
  #Next decision
    *set strength 7`);
  const before = JSON.stringify(s);
  const entry = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Test'), rendered(s, 'Wait')]).options[0];
  assert.deepEqual(entry.effects.filter(effect => effect.kind === 'set').map(effect => effect.after), [15, 12, 17]);
  assert.deepEqual(entry.effects.filter(effect => effect.kind === 'flow').map(effect => effect.command), ['goto', 'page_break', 'fake_choice', 'choice']);
  assert.deepEqual(entry.effectNotes, []);
  assert.equal(JSON.stringify(s), before, 'lookahead does not mutate live variables, position or labels');
});

test('jumping inside a conditional reconstructs its continuation and unvisited choice bodies stay bounded', () => {
  for (const [tail, expected] of [
    [
    `*if ready
  *label inside
  *set strength + 5
*elseif ready
  *set strength 7
*else
  *set strength 7
*set strength - 3`, [15, 12]],
    [
    `*fake_choice
  *if ready
    #Entered option
      *label inside
      *set strength + 5
  *else
    #Skipped option
      *set strength 7
  #Sibling
    *set strength 7
*set strength - 3`, [15]],
  ]) {
    const s = effectScene(`*choice\n  #Test\n    *goto inside\n${tail}\n*choice\n  #Stop\n    *finish`);
    const entry = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Test')]).options[0];
    assert.deepEqual(entry.effects.filter(effect => effect.kind === 'set').map(effect => effect.after), expected, tail);
  }
});

test('current choice exit behavior stays fixed at menu render even if its body changes implicit control flow', async () => {
  for (const initial of [true, false]) for (const random of [true, false]) {
    const { s, options } = await upstreamScene(`*choice
  #Test
    ${random ? '*rand roll 1 2' : '*comment no roll'}
    *set implicit_control_flow ${!initial}
  #Sibling
    *finish
*set score 5
*finish`, { implicit_control_flow: initial, roll: 0, score: 0 });
    const entry = inspectChoiceBlock(s, 0, [''], options).options[0];
    const predicted = entry.effects.filter(effect => effect.name === 'score').map(effect => effect.after);
    assert.deepEqual(predicted, initial ? ['5'] : [], `${initial}, random=${random}`);
    if (initial) s.standardResolution(options[0]);
    else assert.throws(() => s.standardResolution(options[0]), /illegal to fall out/);
    assert.equal(Number(s.stats.score), initial ? 5 : 0);
  }
});

test('current fake and implicit choices preview the shared tail without selecting sibling bodies', () => {
  for (const [command, implicit, expected] of [['*fake_choice', false, [15, 12]], ['*choice', true, [15, 12]], ['*choice', false, [15]]]) {
    const s = effectScene(`${command}
  *if ready
    #Test
      *set strength + 5
  #Sibling
    *set strength 7
*set strength - 3
*choice
  #Stop
    *finish`);
    s.stats.implicit_control_flow = implicit;
    const entry = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Test'), rendered(s, 'Sibling')]).options[0];
    assert.deepEqual(entry.effects.filter(effect => effect.kind === 'set').map(effect => effect.after), expected, command + ':' + implicit);
  }
});

test('chapter lookahead preserves stats, resets temps even for same-scene jumps, and separates identical line positions', () => {
  const s = effectScene(`*choice
  #Test
    *set strength + 5
    *goto_scene SECOND
*label resume
*set strength + 5
*choice
  #Stop
    *finish`);
  s.name = 'first'; s.temps.strength = 20;
  const second = { name: 'second', lines: ['*comment next chapter', '*page_break', '*set strength + 5', '*goto_scene first resume'] };
  const before = JSON.stringify(s);
  const entry = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Test')], { loadScene: name => name.toLowerCase() === 'second' ? second : null }).options[0];
  assert.deepEqual(entry.effects.filter(effect => effect.kind === 'set').map(effect => [effect.scene, effect.scope, effect.before, effect.after]), [
    ['first', 'temps', 20, 25], ['second', 'stats', 10, 15], ['first', 'stats', 15, 20],
  ]);
  assert.deepEqual(entry.effectNotes, []);
  assert.equal(JSON.stringify(s), before);
  const same = effectScene('*choice\n  #Test\n    *goto_scene first resume\n*label resume\n*set strength + 5\n*choice\n  #Stop\n    *finish');
  same.name = 'first'; same.temps.strength = 20;
  const sameEntry = inspectChoiceBlock(same, 0, [''], [rendered(same, 'Test')]).options[0];
  assert.equal(sameEntry.effects.find(effect => effect.kind === 'set').after, 15);
});

test('future choices with state changes, conditions or reuse restrictions remain decision boundaries', () => {
  for (const menu of [
    '*fake_choice\n  #One\n    *set strength + 5\n  #Two\n    *set strength - 3',
    '*fake_choice\n  *if (ready) #One\n  #Two',
    '*fake_choice\n  *hide_reuse #One\n  #Two',
    '*fake_choice\n  #One\n    *input_text label\n  #Two',
    '*choice\n  #One\n  #Two',
  ]) {
    const s = effectScene(`*choice\n  #Test\n    *goto after\n*label after\n${menu}\n*set strength 7`);
    const entry = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Test')]).options[0];
    assert.deepEqual(entry.effects.filter(effect => effect.kind === 'set'), [], menu);
    assert.match(entry.effects.at(-1).command, /^(fake_choice|choice)$/);
  }
  const s = effectScene('*choice\n  #Test\n    *goto after\n*label after\n*fake_choice\n  #One\n  #Two\n*set strength 7');
  s.temps.choice_reuse = 'hide';
  assert.equal(inspectChoiceBlock(s, 0, [''], [rendered(s, 'Test')]).options[0].effects.at(-1).command, 'fake_choice');
});

test('missing passages and sources stay partial, while repeated jumps stop within a bounded preview', () => {
  for (const [command, note] of [['*goto missing', 'Passage unavailable: missing.'], ['*goto_scene missing', 'Chapter source unavailable: missing.']]) {
    const s = effectScene(`*choice\n  #Test\n    *set strength + 5\n    ${command}\n    *set strength 7`);
    const entry = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Test')]).options[0];
    assert.deepEqual(entry.effects.filter(effect => effect.kind === 'set').map(effect => effect.after), [15]);
    assert.deepEqual(entry.effectNotes, [note]);
  }
  const s = effectScene('*choice\n  #Test\n    *goto loop\n*label loop\n*page_break\n*goto loop');
  const entry = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Test')]).options[0];
  assert.ok(entry.effects.length < 10);
  assert.deepEqual(entry.effectNotes, ['Preview stopped at a repeated passage.']);
});

test('indirect jumps use projected values and stop on unresolved or random destinations', async () => {
  const { s, options, randomCalls } = await upstreamScene(`*choice
  #Test
    *temp destination "reward"
    *goto {destination}
    *set score 999
*label reward
*set score +5
*choice
  #Stop
    *finish`, { score: 0 });
  const effects = inspectChoiceBlock(s, 0, [''], options).options[0].effects;
  assert.deepEqual(effects.filter(effect => effect.kind === 'set').map(effect => effect.after), [5]);
  assert.equal(randomCalls(), 0);
  assert.equal(s.stats.score, 0);
  for (const command of ['*goto {missing}', '*rand destination 1 1000\n    *goto {destination}']) {
    const { s, options } = await upstreamScene(`*choice\n  #Test\n    ${command}\n    *set score 999\n  #Wait\n    *finish`, { score: 0, destination: 0 });
    const entry = inspectChoiceBlock(s, 0, [''], options).options[0];
    assert.equal(entry.effects.some(effect => effect.name === 'score'), false);
    assert.deepEqual(entry.effectNotes, ['Destination could not be predicted.']);
  }
});

test('random paths that jump to a shared continuation retain probabilities and place shared effects after both branches', async () => {
  const { s, options, randomCalls } = await upstreamScene(`*choice
  #Roll
    *rand roll 1 2
    *if roll = 1
      *goto reward
    *set score +3
    *goto reward
*label reward
*set score +5
*choice
  #Stop
    *finish`, { score: 0, roll: 0 });
  const entry = inspectChoiceBlock(s, 0, [''], options).options[0];
  const changes = entry.effects.filter(effect => effect.name === 'score');
  assert.deepEqual(changes[0].afterValues, [3]);
  assert.equal(changes[0].chance, .5);
  assert.deepEqual(changes[1].afterValues, [5, 8]);
  assert.equal(changes[1].chance, 1);
  assert.deepEqual(entry.effectNotes, []);
  assert.equal(s.stats.score, 0);
  assert.equal(randomCalls(), 0);
});

test('reference-style checkpoint bookkeeping can cross chapters beyond the direct-body effect limit', () => {
  const s = effectScene('*choice\n  #Test\n    *goto_scene checkpoint'); s.name = 'first';
  for (let index = 0; index < 67; index++) s.stats['saved' + index] = 0;
  const checkpoint = { name: 'checkpoint', lines: [...Array.from({ length: 67 }, (_, index) => `*set saved${index} strength`), '*page_break', '*goto_scene second'] };
  const second = { name: 'second', lines: ['*set strength + 5', '*choice', '  #Stop', '    *finish'] };
  const entry = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Test')], { loadScene: name => ({ checkpoint, second })[name] }).options[0];
  assert.equal(entry.effects.filter(effect => effect.kind === 'set').length, 68);
  assert.equal(entry.effects.findLast(effect => effect.kind === 'set').after, 15);
  assert.deepEqual(entry.effectNotes, []);
});

test('custom finish captions and scene-end fallthrough use chapter order without treating captions as labels', () => {
  for (const source of [
    '*choice\n  #Test\n    *finish Journey to the next chapter',
    '*fake_choice\n  #Test\n    A quiet moment.\nShared story text.',
  ]) {
    const s = effectScene(source); s.name = 'first';
    const entry = inspectChoiceBlock(s, 0, [''], [rendered(s, 'Test')], {
      nextScene: name => name === 'first' ? 'second' : null,
      loadScene: name => name === 'second' ? { name, lines: ['*set strength + 5', '*choice', '  #Stop', '    *finish'] } : null,
    }).options[0];
    assert.equal(entry.effects.find(effect => effect.kind === 'set').after, 15);
    assert.deepEqual(entry.effectNotes, []);
    assert.equal(s.stats.strength, 10);
  }
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
