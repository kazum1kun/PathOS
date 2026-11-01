// Serialized into the game frame alongside the runtime. Inspect source without
// executing option bodies or changing the live scene's variables or position.
export function inspectChoiceBlock(scene, startLine, groups, renderedOptions, context = {}) {
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
      if (typeof original !== 'function') for (const name of expression.replace(/"(?:\\.|[^"\\])*"/g, '').match(/[a-z_][a-z_0-9]*/gi) || []) record(name);
      target.lineNum = line;
      const value = target.evaluateExpr(target.tokenizeExpr(expression));
      return { known: value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), value, values: [...values.values()] };
    } catch { return { known: false, uncertain, values: [...values.values()] }; }
    finally { if (own) target.getVar = original; else delete target.getVar; }
  }
  function booleanValue(value) {
    return value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
  }
  function condition(kind, expression, line, result) {
    const read = result === undefined ? readExpression(shadow, expression, line) : null;
    return { kind, expression, line: line + 1, result: read ? (read.known ? booleanValue(read.value) : null) : result, values: read?.values || [] };
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
  const previewSources = new Map();
  const knownScenes = new Map(typeof scene.name === 'string' ? [[scene.name.toLowerCase(), { name: scene.name, lines }]] : []);
  const implicit = readExpression(shadow, 'implicit_control_flow', startLine);
  // The engine records this when rendering the menu. Changing the flag inside
  // an option does not change the exit behavior of that already-rendered menu.
  const currentFallsThrough = /^\s*\*fake_choice\b/i.test(lines[startLine]) || implicit.known && booleanValue(implicit.value) === true;
  function previewEffects(from, to, option) {
    const records = new Map(), edges = new Map(), effectNotes = new Set(), sources = previewSources;
    let steps = 0, worlds = 1, recordLimit = 40;
    function sourceOf(target) {
      let source = sources.get(target.lines);
      if (source) return source;
      const lines = target.lines, indent = at => /^\s*/.exec(lines[at] || '')[0].length;
      const end = (at, limit = lines.length) => { let next = at + 1; while (next < limit && (!lines[next].trim() || indent(next) > indent(at))) next++; return next; };
      const labels = new Map(), regions = [], choices = [];
      for (let at = 0; at < lines.length; at++) {
        const command = /^\s*\*([a-z_]+)\b\s*(.*)$/i.exec(lines[at]);
        if (!command) continue;
        const kind = command[1].toLowerCase();
        if (kind === 'label') labels.set(command[2].trim().toLowerCase(), at);
        if (kind === 'choice' || kind === 'fake_choice') choices.push({ from: at, to: end(at) });
        if (/^(if|elseif|elsif|else)$/.test(kind)) {
          const inline = parenthetical(command[2]);
          if (inline && /^#/.test(inline.rest)) continue;
          let after = end(at);
          while (after < lines.length) {
            let next = after;
            while (next < lines.length && (!lines[next].trim() || /^\s*\*comment\b/i.test(lines[next]))) next++;
            if (indent(next) !== indent(at) || !/^\s*\*(elseif|elsif|else)\b/i.test(lines[next] || '')) break;
            after = end(next);
          }
          regions.push({ from: at + 1, to: end(at), after });
        }
      }
      for (let at = 0; at < lines.length; at++) {
        let text = lines[at].trim();
        text = text.replace(/^(?:\*(?:hide_reuse|disable_reuse|allow_reuse)\s+)+/i, '');
        const guarded = /^\*(?:if|elseif|elsif|selectable_if)\s+(.+)$/i.exec(text);
        if (guarded) text = parenthetical(guarded[1])?.rest || '';
        if (!text.startsWith('#')) continue;
        const choice = choices.filter(item => item.from < at && at < item.to).at(-1);
        if (choice) regions.push({ from: at + 1, to: end(at), after: choice.to, choice });
      }
      source = { id: sources.size, lines, end, labels, regions };
      sources.set(lines, source); return source;
    }
    function emit(state, at, effect) {
      const location = `${sourceOf(state.target).id}:${at}`, occurrence = state.visits.get(location) || 0;
      state.visits.set(location, occurrence + 1);
      const key = `${location}:${occurrence}`;
      let record = records.get(key);
      if (!record) { const { range, ...details } = effect; record = { ...details, scene: state.target.name, chance: 0, beforeValues: [], afterValues: [], ranges: [] }; records.set(key, record); }
      if (state.latest && state.latest !== key) {
        if (!edges.has(state.latest)) edges.set(state.latest, new Set());
        edges.get(state.latest).add(key);
      }
      state.latest = key;
      record.chance += state.weight;
      for (const [key, value] of [['beforeValues', effect.before], ['afterValues', effect.after]]) {
        if (!record[key].some(item => JSON.stringify(item) === JSON.stringify(value))) record[key].push(value);
      }
      if (effect.range && !record.ranges.some(item => JSON.stringify(item) === JSON.stringify(effect.range))) record.ranges.push(effect.range);
      if (effect.afterUnknown) record.afterUnknown = true;
      if (effect.beforeUnknown) record.beforeUnknown = true;
    }
    function unavailable(state, at, description = 'Unparsed effect.') { emit(state, at, { kind: 'unknown', description }); }
    function literal(target, text, at, unknown) {
      if (/^\{[^{}]+\}$/.test(text)) {
        const read = readExpression(target, text.slice(1, -1), at, unknown);
        return read.known && typeof read.value === 'string' ? read.value : null;
      }
      return text && !/[{}\[\]]/.test(text) ? text : null;
    }
    function travel(state, at) {
      const stats = { ...state.target.stats }; delete stats.scene;
      const key = JSON.stringify([sourceOf(state.target).id, at, stats, state.target.temps, [...state.unknown].sort()]);
      if (state.route.has(key)) { effectNotes.add('Preview stopped at a repeated passage.'); return false; }
      state.route.add(key); recordLimit = 160; return true;
    }
    // A jump abandons the old lexical block. Reconstruct only the blocks that
    // contain its destination, so an else or a sibling option is never executed.
    function continueFrom(first, states, depth) {
      if (!states.length) return [];
      const source = sourceOf(states[0].target);
      const region = source.regions.filter(item => item.from <= first && first < item.to).sort((a, b) => a.to - b.to || b.from - a.from)[0];
      const resumed = walk(first, region?.to ?? source.lines.length, states, depth);
      if (region) {
        // A label can enter a choice that has never rendered. Its option exit
        // table does not exist, even if the source says *fake_choice.
        const eligible = region.choice ? resumed.filter(state => state.target.lines === lines && region.choice.from === startLine && currentFallsThrough) : resumed;
        if (region.choice && resumed.length > eligible.length) effectNotes.add('Preview stopped at a choice boundary.');
        return continueFrom(region.after, eligible, depth + 1);
      }
      // Falling off the end of a scene has the same continuation as *finish.
      for (const state of resumed) {
        const next = context.nextScene?.(state.target.name);
        if (typeof next === 'string' && travel(state, source.lines.length)) {
          emit(state, source.lines.length, { kind: 'flow', command: 'finish', destination: next, continued: true });
          enterScene(state, next, null, depth + 1);
        }
      }
      return [];
    }
    function enterScene(state, name, label, depth) {
      let data;
      try { data = knownScenes.get(name.toLowerCase()) || context.loadScene?.(name); } catch { /* unavailable source */ }
      if (!data || !Array.isArray(data.lines) || !data.lines.every(line => typeof line === 'string')) { effectNotes.add(`Chapter source unavailable: ${name}.`); return; }
      knownScenes.set(name.toLowerCase(), data);
      const target = cloneScene(state.target);
      if (target.stats.choice_subscene_stack?.length) delete target.stats.choice_subscene_stack;
      target.name = data.name || name; target.lines = data.lines; target.stats.sceneName = target.name;
      target.temps = { choice_reuse: 'allow', choice_user_restored: false, _choiceEnds: {}, param: [] };
      state.target = target;
      state.unknown = new Set([...state.unknown].filter(name => Object.hasOwn(target.stats, name)));
      const at = label === null ? 0 : sourceOf(target).labels.get(label.toLowerCase());
      if (at === undefined) { effectNotes.add(`Passage unavailable: ${label}.`); return; }
      continueFrom(label === null ? at : at + 1, [state], depth);
    }
    function cosmeticChoice(source, at, last, target) {
      if (target.temps.choice_reuse && target.temps.choice_reuse !== 'allow') return false;
      let options = 0;
      for (let line = at + 1; line < last; line++) {
        const text = source.lines[line].trim();
        if (text.startsWith('#')) { options++; continue; }
        if (text.startsWith('*') && !/^\*(comment|print|line_break|image|sound|link|link_button|text_image|youtube)\b/i.test(text)) return false;
      }
      return options > 0;
    }
    function walk(first, last, states, depth = 0) {
      if (depth > 24) { effectNotes.add('More effects.'); return []; }
      if (!states.length) return [];
      const source = sourceOf(states[0].target), lines = source.lines, blockEnd = source.end;
      for (let at = first; at < last;) {
        if (!states.length) return [];
        if (++steps > 800 || (previewBudget -= states.length) < 0 || records.size >= recordLimit) { effectNotes.add('More effects.'); return []; }
        const text = lines[at].trim(), command = /^\*([a-z_]+)\b\s*(.*)$/i.exec(text);
        if (!text || /^\*comment\b/i.test(text)) { at++; continue; }
        if (command && command[1].toLowerCase() === 'if') {
          let pending = states, resumed = [], branchAt = at, branchCommand = command;
          for (;;) {
            const end = blockEnd(branchAt, last), yes = [], no = [];
            for (const state of pending) {
              const read = branchCommand[1].toLowerCase() === 'else' ? { known: true, value: true } : readExpression(state.target, branchCommand[2], branchAt, state.unknown);
              const result = read.known ? booleanValue(read.value) : null;
              if (result === null) unavailable(state, branchAt, 'Conditional effects.');
              else (result ? yes : no).push(state);
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
        if (!command) {
          if (/^#/.test(text)) { effectNotes.add('Preview stopped at another choice.'); return []; }
          at++; continue;
        }
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
            rolls.push({ state, name, scope: current.scope, min, fixed: min === max, minimum: low.value, count: min === max ? 1 : integer ? max - min + 1 : Infinity });
          }
          const extraWorlds = rolls.reduce((sum, roll) => sum + roll.count - 1, 0), expand = worlds + extraWorlds <= 128;
          if (expand) worlds += extraWorlds;
          states = rolls.flatMap(({ state, name, scope, min, fixed, minimum, count }) => {
            // The engine assigns the original minimum when both bounds are
            // equal, preserving strings such as "1.0" without drawing a roll.
            if (fixed) { state.target[scope][name] = minimum; state.unknown.delete(name); return [state]; }
            if (!expand) { state.unknown.add(name); return [state]; }
            return Array.from({ length: count }, (_, index) => {
              const target = cloneScene(state.target), unknown = new Set(state.unknown); unknown.delete(name);
              target[scope][name] = min + index;
              return { ...state, target, unknown, visits: new Map(state.visits), route: new Set(state.route), weight: state.weight / count };
            });
          });
        } else if (kind === 'achieve') {
          for (const state of states) emit(state, at, { kind, description: `Unlock achievement: ${scene.nav?.achievements?.[data.toLowerCase()]?.title || data}` });
        } else if (kind === 'page_break') {
          recordLimit = 160;
          for (const state of states) emit(state, at, { kind: 'flow', command: kind, destination: '', continued: true });
        } else if (kind === 'goto' || kind === 'goto_scene' || kind === 'finish') {
          for (const state of states) {
            const args = kind === 'finish' ? [] : kind === 'goto' ? [data.trim()] : argumentsOf(data);
            const name = kind === 'finish' ? context.nextScene?.(state.target.name) : literal(state.target, args[0], at, state.unknown);
            const label = args[1] === undefined ? null : literal(state.target, args[1], at, state.unknown);
            const supported = typeof name === 'string' && label !== undefined && (kind === 'goto' || args.length <= 2) && (args[1] === undefined || label !== null);
            emit(state, at, { kind: 'flow', command: kind, destination: [name || args[0], label].filter(Boolean).join(' ') });
            if (!supported) { if (kind !== 'finish') effectNotes.add('Destination could not be predicted.'); continue; }
            if (!travel(state, at)) continue;
            if (kind === 'goto') {
              const destination = source.labels.get(name.toLowerCase());
              if (destination === undefined) effectNotes.add(`Passage unavailable: ${name}.`);
              else continueFrom(destination + 1, [state], depth + 1);
            } else enterScene(state, name, label, depth + 1);
          }
          return [];
        } else if (kind === 'fake_choice' && !data.trim() && states.every(state => cosmeticChoice(source, at, blockEnd(at, last), state.target))) {
          recordLimit = 160;
          for (const state of states) emit(state, at, { kind: 'flow', command: kind, destination: '', continued: true });
          at = blockEnd(at, last); continue;
        } else if (/^(gosub|gosub_scene|return|ending|abort|bug|restart|choice|fake_choice|input_text|input_number|redirect|delay_break|advertisement|restore_game|restore_password)$/i.test(kind)) {
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
    const target = cloneScene();
    if (option.reuse && option.reuse !== 'allow') { target.temps.choice_used ||= {}; target.temps.choice_used[option.line - 1] = 1; }
    const states = walk(from, to, [{ target, unknown: new Set(), visits: new Map(), route: new Set(), weight: 1 }]);
    if (currentFallsThrough) {
      recordLimit = 160; continueFrom(limit, states, 0);
    }
    // Merge random worlds in execution order: a shared continuation must follow
    // the effects from every branch that reaches it, even across jumps.
    const incoming = new Map([...records.keys()].map(key => [key, 0])), ordered = [];
    for (const next of edges.values()) for (const key of next) incoming.set(key, incoming.get(key) + 1);
    const ready = [...incoming.keys()].filter(key => incoming.get(key) === 0);
    for (let index = 0; index < ready.length; index++) {
      const key = ready[index]; ordered.push(records.get(key));
      for (const next of edges.get(key) || []) { incoming.set(next, incoming.get(next) - 1); if (!incoming.get(next)) ready.push(next); }
    }
    if (ordered.length !== records.size) effectNotes.add('Effect order varies across random outcomes.');
    const effects = ordered.length === records.size ? ordered : [...records.values()];
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
        else Object.assign(entry, previewEffects(at + 1, end, option));
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
