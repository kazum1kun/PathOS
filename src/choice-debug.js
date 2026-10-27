// Serialized into the game frame alongside the runtime. Inspect source without
// executing option bodies or changing the live scene's variables or position.
export function inspectChoiceBlock(scene, startLine, groups, renderedOptions) {
  const lines = scene.lines || [];
  const existing = new Map(), boundaries = new Set();
  function index(options) { for (const option of options || []) { existing.set(option.line - 1, option); index(option.suboptions); } }
  index(renderedOptions);
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  function cloneScene(source = scene) {
    const target = Object.assign(Object.create(Object.getPrototypeOf(source)), source);
    const stats = { ...source.stats }; delete stats.scene;
    target.stats = copy(stats); target.stats.scene = target;
    target.temps = copy(source.temps || {}); target.debugMode = false;
    return target;
  }
  const shadow = cloneScene();
  const startIndent = shadow.getIndent(lines[startLine] || '');
  const notes = new Set();
  function variable(target, name) {
    name = name.toLowerCase();
    for (const scope of ['temps', 'stats']) if (name !== 'scene' && Object.hasOwn(target[scope], name)) return { name, scope, value: copy(target[scope][name]) };
    return null;
  }
  function readExpression(target, expression, line, unknown = new Set()) {
    const values = new Map(), original = target.getVar, own = Object.hasOwn(target, 'getVar');
    let uncertain = false;
    const record = name => {
      name = String(name).toLowerCase();
      if (unknown.has(name)) { uncertain = true; throw new Error('Random value'); }
      const value = variable(target, name); if (value && values.size < 16) values.set(value.name, value);
    };
    // Capture actual engine reads, including indirect references. The lexical
    // fallback supports engines that read directly from stats instead of getVar.
    if (typeof original === 'function') target.getVar = function(name, ...args) { record(name); return original.call(this, name, ...args); };
    try {
      for (const name of expression.replace(/"(?:\\.|[^"\\])*"/g, '').match(/[a-z_][a-z_0-9]*/gi) || []) record(name);
      target.lineNum = line;
      const value = target.evaluateExpr(target.tokenizeExpr(expression));
      return { known: value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), value, values: [...values.values()] };
    } catch { return { known: false, uncertain, values: [...values.values()] }; }
    finally { if (own) target.getVar = original; else delete target.getVar; }
  }
  function condition(kind, expression, line, result) {
    const read = result === undefined ? readExpression(shadow, expression, line) : null;
    return { kind, expression, line: line + 1, result: read ? (read.known && typeof read.value === 'boolean' ? read.value : null) : result, values: read?.values || [] };
  }
  function indent(at) { shadow.lineNum = at; return shadow.getIndent(lines[at]); }
  function blockEnd(at, limit) { let next = at + 1; while (next < limit && (!lines[next].trim() || indent(next) > indent(at))) next++; return next; }
  // Split random arguments at whitespace outside grouped expressions/strings.
  function argumentsOf(text) {
    const result = []; let part = '', depth = 0, quoted = false, escaped = false;
    for (const char of text) {
      if (/\s/.test(char) && !quoted && !depth) { if (part) result.push(part); part = ''; continue; }
      part += char;
      if (escaped) { escaped = false; continue; }
      if (char === '\\' && quoted) { escaped = true; continue; }
      if (char === '"') quoted = !quoted;
      if (!quoted) { if ('({['.includes(char)) depth++; if (')}]'.includes(char)) depth--; }
    }
    if (part) result.push(part);
    return depth || quoted ? [] : result;
  }
  let previewBudget = 6000;
  function previewEffects(from, to) {
    const records = new Map(), effectNotes = new Set(); let steps = 0, worlds = 1;
    if (from >= to) return { effects: [], effectNotes: ['Effects unavailable.'] };
    function emit(state, at, effect) {
      let record = records.get(at);
      if (!record) { const { range, ...details } = effect; record = { ...details, chance: 0, beforeValues: [], afterValues: [], ranges: [] }; records.set(at, record); }
      record.chance += state.weight;
      for (const [key, value] of [['beforeValues', effect.before], ['afterValues', effect.after]]) {
        if (!record[key].some(item => JSON.stringify(item) === JSON.stringify(value))) record[key].push(value);
      }
      if (effect.range && !record.ranges.some(item => JSON.stringify(item) === JSON.stringify(effect.range))) record.ranges.push(effect.range);
      if (effect.afterUnknown) record.afterUnknown = true;
      if (effect.beforeUnknown) record.beforeUnknown = true;
    }
    function unavailable(state, at, description = 'Unparsed effect.') { emit(state, at, { kind: 'unknown', description }); }
    function walk(first, last, states, depth = 0) {
      if (depth > 12) { effectNotes.add('More effects.'); return []; }
      for (let at = first; at < last;) {
        if (!states.length) return [];
        if (++steps > 200 || (previewBudget -= states.length) < 0 || records.size >= 40) { effectNotes.add('More effects.'); return []; }
        const text = lines[at].trim(), command = /^\*([a-z_]+)\b\s*(.*)$/i.exec(text);
        if (!text || /^\*comment\b/i.test(text)) { at++; continue; }
        if (command && command[1].toLowerCase() === 'if') {
          let pending = states, resumed = [], branchAt = at, branchCommand = command;
          for (;;) {
            const end = blockEnd(branchAt, last), yes = [], no = [];
            for (const state of pending) {
              const read = branchCommand[1].toLowerCase() === 'else' ? { known: true, value: true } : readExpression(state.target, branchCommand[2], branchAt, state.unknown);
              if (!read.known || typeof read.value !== 'boolean') unavailable(state, branchAt, 'Conditional effects.');
              else (read.value ? yes : no).push(state);
            }
            resumed.push(...walk(branchAt + 1, end, yes, depth + 1)); pending = no;
            let next = end;
            while (next < last && (!lines[next].trim() || /^\s*\*comment\b/i.test(lines[next]))) next++;
            const nextCommand = next < last && /^\s*\*(elseif|elsif|else)\b\s*(.*)$/i.exec(lines[next]);
            if (!nextCommand) { at = end; break; }
            branchAt = next; branchCommand = nextCommand;
          }
          states = [...resumed, ...pending]; continue;
        }
        if (!command) { at++; continue; }
        const kind = command[1].toLowerCase(), data = command[2];
        if (kind === 'set' || kind === 'temp') {
          const assignment = /^([a-z][a-z_0-9]*)(?:\s+|(?=[+\-*/%&]))?(.*)$/i.exec(data);
          states = states.filter(state => {
            if (!assignment || /^(constructor|prototype|__proto__)$/i.test(assignment[1])) { unavailable(state, at); return false; }
            const { target, unknown } = state, name = assignment[1].toLowerCase(), current = variable(target, name);
            if (kind === 'set' && (!current || !assignment[2])) { unavailable(state, at); return false; }
            const scope = kind === 'temp' ? 'temps' : current.scope;
            let expression = assignment[2] || '';
            if (kind === 'set' && /^(?:%[+-]|[+\-*/&])/.test(expression)) expression = name + ' ' + expression;
            const read = !expression && kind === 'temp' ? { known: true, value: null } : readExpression(target, expression, at, unknown);
            if (!read.uncertain && (!read.known || !['string', 'number', 'boolean'].includes(typeof read.value) && read.value !== null)) { unavailable(state, at); return false; }
            const before = Object.hasOwn(target[scope], name) ? copy(target[scope][name]) : undefined;
            emit(state, at, { kind, name, scope, before, after: read.value, afterUnknown: !!read.uncertain, beforeUnknown: unknown.has(name) });
            if (read.uncertain) unknown.add(name); else { target[scope][name] = read.value; unknown.delete(name); }
            return true;
          });
        } else if (kind === 'rand') {
          const args = argumentsOf(data), rolls = [];
          for (const state of states) {
            const name = args[0]?.toLowerCase(), current = name && variable(state.target, name);
            const low = args.length === 3 && readExpression(state.target, args[1], at, state.unknown), high = args.length === 3 && readExpression(state.target, args[2], at, state.unknown);
            const min = Number(low?.value), max = Number(high?.value);
            if (!current || !low.known || !high.known || !Number.isFinite(min) || !Number.isFinite(max) || min > max) { unavailable(state, at, 'Random effect.'); continue; }
            // Decimal literals keep their continuous semantics, even if a game
            // evaluator converts their textual representation into a number.
            const integer = [low.value, high.value].every(value => String(parseInt(value, 10)) === String(value)) && ![args[1], args[2]].some(value => /^-?\d+\.\d+$/.test(value));
            const range = { min, max, integer };
            emit(state, at, { kind: 'rand', name, scope: current.scope, before: current.value, beforeUnknown: state.unknown.has(name), range });
            rolls.push({ state, name, scope: current.scope, min, count: min === max ? 1 : integer ? max - min + 1 : Infinity });
          }
          const extraWorlds = rolls.reduce((sum, roll) => sum + roll.count - 1, 0), expand = worlds + extraWorlds <= 128;
          if (expand) worlds += extraWorlds;
          states = rolls.flatMap(({ state, name, scope, min, count }) => {
            if (!expand) { state.unknown.add(name); return [state]; }
            return Array.from({ length: count }, (_, index) => {
              const target = cloneScene(state.target), unknown = new Set(state.unknown); unknown.delete(name);
              target[scope][name] = min + index;
              return { target, unknown, weight: state.weight / count };
            });
          });
        } else if (kind === 'achieve') {
          for (const state of states) emit(state, at, { kind, description: `Unlock achievement: ${scene.nav?.achievements?.[data.toLowerCase()]?.title || data}` });
        } else if (/^(goto|goto_scene|gosub|gosub_scene|return|finish|ending|abort|bug|restart|page_break|choice|fake_choice|input_text|input_number|redirect|delay_break|advertisement|restore_game|restore_password)$/i.test(kind)) {
          for (const state of states) emit(state, at, { kind: 'flow', command: kind, destination: argumentsOf(data).slice(0, /^(goto_scene|gosub_scene)$/.test(kind) ? 2 : 1).join(' ') });
          return [];
        } else if (/^(print|line_break|image|sound|link|link_button|label|stat_chart|text_image|youtube)$/i.test(kind)) {
          // Display commands do not need to run to preview variable changes.
          if (kind === 'stat_chart') { at = blockEnd(at, last); continue; }
        } else { for (const state of states) unavailable(state, at, kind === 'script' ? 'Scripted effect.' : 'Unparsed effect.'); return []; }
        at++;
      }
      return states;
    }
    walk(from, to, [{ target: cloneScene(), unknown: new Set(), weight: 1 }]);
    const effects = [...records.values()];
    for (const effect of effects) effect.chance = Math.abs(effect.chance - 1) < 1e-9 ? 1 : Math.min(1, effect.chance);
    if (effectNotes.size || effects.some(effect => effect.kind === 'unknown')) for (const effect of effects) if (effect.chance < 1) effect.chance = undefined;
    return { effects, effectNotes: [...effectNotes] };
  }
  // Parentheses inside quoted strings do not close an inline condition.
  function parenthetical(text) {
    if (text[0] !== '(') return null;
    let depth = 0, quoted = false, escaped = false;
    for (let at = 0; at < text.length; at++) {
      const char = text[at];
      if (escaped) { escaped = false; continue; }
      if (char === '\\' && quoted) { escaped = true; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (char === '(') depth++;
      if (char === ')' && --depth === 0) return { expression: text.slice(1, at), rest: text.slice(at + 1).trim() };
    }
    return null;
  }
  let limit = startLine + 1;
  while (limit < lines.length && (!lines[limit].trim() || indent(limit) > startIndent)) limit++;
  let last = limit - 1; while (last > startLine && !lines[last].trim()) last--;
  function parse(from, to, inherited, groupIndex, context = []) {
    const options = []; let branches = [];
    for (let at = from; at < to;) {
      if (!lines[at].trim() || /^\s*\*comment\b/i.test(lines[at])) { at++; continue; }
      const end = blockEnd(at, to), conditions = [...inherited];
      let text = lines[at].trim(), reuse = shadow.temps.choice_reuse || 'allow';
      for (;;) {
        const modifier = /^\*(hide_reuse|disable_reuse|allow_reuse)\s+(.+)$/i.exec(text);
        if (modifier) { reuse = modifier[1].split('_')[0].toLowerCase(); text = modifier[2].trim(); continue; }
        const weight = /^\*random_weight\s+(.+)$/i.exec(text);
        if (weight) { const part = parenthetical(weight[1]); if (part) { text = part.rest; continue; } }
        break;
      }
      const command = /^\*(if|elseif|elsif|else|selectable_if)\b\s*(.*)$/i.exec(text);
      if (command) {
        const kind = command[1].toLowerCase(), data = command[2].trim(), inline = parenthetical(data);
        if (inline && /^#/.test(inline.rest)) {
          conditions.push(condition(kind, inline.expression, at)); text = inline.rest;
        } else if (kind !== 'selectable_if') {
          const previous = [...branches];
          if (kind === 'if') branches = [];
          else if (!previous.length) notes.add('Unmatched conditional branch.');
          if (kind !== 'if') {
            const result = previous.some(item => item.result === true) ? false : previous.every(item => item.result === false) ? true : null;
            conditions.push({ ...condition('earlier branches', previous.map(item => `not (${item.expression})`).join(' and ') || 'unknown', at, result), values: [...new Map(previous.flatMap(item => item.values).map(value => [value.name, value])).values()] });
          }
          if (kind !== 'else') { const test = condition(kind, data, at); conditions.push(test); branches.push(test); }
          boundaries.add(at);
          options.push(...parse(at + 1, end, conditions, groupIndex, [...context, ...previous.map(item => item.line - 1), at])); at = end; continue;
        }
      } else branches = [];
      if (/^\*print\s+/i.test(text)) {
        try { shadow.lineNum = at; text = String(shadow.evaluateExpr(shadow.tokenizeExpr(text.replace(/^\*print\s+/i, '')))); }
        catch { notes.add('Generated option.'); }
      }
      if (/^#\s*\S/.test(text)) {
        boundaries.add(at);
        const original = existing.get(at), used = !!shadow.temps.choice_used?.[at];
        if (reuse !== 'allow') conditions.push({ ...condition(`${reuse}_reuse`, 'not previously selected', at, !used), values: [{ scope: 'choice', name: 'previously selected', value: used }] });
        let name = text.replace(/^#\s*/, '');
        try { shadow.lineNum = at; name = shadow.replaceVariables(name); } catch { /* retain source when a hidden branch needs missing variables */ }
        const option = original || { name, group: groups[groupIndex] || 'choice', line: at + 1, endLine: end, ...(reuse !== 'allow' ? { reuse } : {}) };
        const hidden = !original || conditions.some(item => item.result === false && item.kind !== 'selectable_if' && item.kind !== 'disable_reuse');
        const disabled = !!original?.unselectable || conditions.some(item => item.result === false && (item.kind === 'selectable_if' || item.kind === 'disable_reuse'));
        const entry = { option, name: original?.name || name, conditions, availability: hidden ? 'hidden' : disabled ? 'disabled' : 'available', source: { from: at, to: end, context: [startLine, ...context] } };
        if (groupIndex + 1 < groups.length) entry.children = parse(at + 1, end, conditions, groupIndex + 1, [...context, at]);
        else Object.assign(entry, previewEffects(at + 1, end));
        options.push(entry);
      } else if (!/^\*comment\b/i.test(text)) notes.add('Some choices use generated syntax.');
      at = end;
    }
    return options;
  }
  const options = parse(startLine + 1, limit, [], 0), inspected = new Set();
  function collect(entries) { for (const entry of entries) { inspected.add(entry.option.line - 1); if (entry.children) collect(entry.children); } }
  collect(options);
  for (const [line, option] of existing) if (!inspected.has(line) && !option.suboptions?.length) {
    const conditions = [...(option.displayIf || []).map(expression => condition('if', expression, line)), ...(option.selectableIf ? [condition('selectable_if', option.selectableIf, line)] : [])];
    options.push({ option, name: option.name, conditions, availability: option.unselectable ? 'disabled' : 'available', effects: [], effectNotes: ['Effects unavailable.'], source: { from: line, to: option.endLine || line + 1, context: [startLine] } });
  }
  return { options, boundaries: [...boundaries], choiceEnd: last, notes: [...notes] };
}
