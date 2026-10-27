// Serialized into the game frame alongside the runtime. Inspect source without
// executing option bodies or changing the live scene's variables or position.
export function inspectChoiceBlock(scene, startLine, groups, renderedOptions) {
  const lines = scene.lines || [];
  const existing = new Map(), boundaries = new Set();
  function index(options) { for (const option of options || []) { existing.set(option.line - 1, option); index(option.suboptions); } }
  index(renderedOptions);
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  function cloneScene() {
    const target = Object.assign(Object.create(Object.getPrototypeOf(scene)), scene);
    const stats = { ...scene.stats }; delete stats.scene;
    target.stats = copy(stats); target.stats.scene = target;
    target.temps = copy(scene.temps || {}); target.debugMode = false;
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
  function readExpression(target, expression, line) {
    const values = new Map(), original = target.getVar, own = Object.hasOwn(target, 'getVar');
    const record = name => { const value = variable(target, String(name)); if (value && values.size < 16) values.set(value.name, value); };
    // Capture actual engine reads, including indirect references. The lexical
    // fallback supports engines that read directly from stats instead of getVar.
    if (typeof original === 'function') target.getVar = function(name, ...args) { record(name); return original.call(this, name, ...args); };
    try {
      for (const name of expression.replace(/"(?:\\.|[^"\\])*"/g, '').match(/[a-z_][a-z_0-9]*/gi) || []) record(name);
      target.lineNum = line;
      const value = target.evaluateExpr(target.tokenizeExpr(expression));
      return { known: value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), value, values: [...values.values()] };
    } catch { return { known: false, values: [...values.values()] }; }
    finally { if (own) target.getVar = original; else delete target.getVar; }
  }
  function condition(kind, expression, line, result) {
    const read = result === undefined ? readExpression(shadow, expression, line) : null;
    return { kind, expression, line: line + 1, result: read ? (read.known && typeof read.value === 'boolean' ? read.value : null) : result, values: read?.values || [] };
  }
  function indent(at) { shadow.lineNum = at; return shadow.getIndent(lines[at]); }
  function blockEnd(at, limit) { let next = at + 1; while (next < limit && (!lines[next].trim() || indent(next) > indent(at))) next++; return next; }
  let previewBudget = 2000;
  function previewEffects(from, to) {
    const effects = [], effectNotes = [];
    if (from >= to) return { effects, effectNotes: ['Effect preview unavailable: this option has no inspectable body.'] };
    if (previewBudget <= 0) return { effects, effectNotes: ['Effect preview limit reached.'] };
    const target = cloneScene(); let steps = 0;
    function stop(message) { effectNotes.push(message); return false; }
    function walk(first, last, depth = 0) {
      if (depth > 12) return stop('Preview stopped at deeply nested code. Later effects are unknown.');
      let branch = null;
      for (let at = first; at < last;) {
        if (++steps > 200 || --previewBudget < 0 || effects.length >= 40) return stop('Effect preview limit reached. Later effects are unknown.');
        const text = lines[at].trim(), command = /^\*([a-z_]+)\b\s*(.*)$/i.exec(text);
        if (!text || /^\*comment\b/i.test(text)) { at++; continue; }
        if (command && /^(if|elseif|elsif|else)$/i.test(command[1])) {
          const kind = command[1].toLowerCase(), end = blockEnd(at, last);
          if (kind === 'if') branch = false;
          else if (branch === null) return stop(`Unmatched *${kind} at line ${at + 1}; later effects are unknown.`);
          if (!branch) {
            const read = kind === 'else' ? { known: true, value: true } : readExpression(target, command[2], at);
            if (!read.known || typeof read.value !== 'boolean') return stop(`Cannot resolve *${kind} ${command[2]} at line ${at + 1}; later effects depend on this check.`);
            if (read.value) { branch = true; if (!walk(at + 1, end, depth + 1)) return false; }
          }
          at = end; continue;
        }
        branch = null;
        if (!command) { at++; continue; }
        const kind = command[1].toLowerCase(), data = command[2];
        if (kind === 'set' || kind === 'temp') {
          const assignment = /^([a-z][a-z_0-9]*)(?:\s+(.+))?$/i.exec(data);
          if (!assignment || /^(constructor|prototype|__proto__)$/i.test(assignment[1])) return stop(`Dynamic or unsupported *${kind} at line ${at + 1}; later effects are unknown.`);
          const name = assignment[1].toLowerCase(), current = variable(target, name);
          if (kind === 'set' && (!current || !assignment[2])) return stop(`Cannot resolve *set ${data} at line ${at + 1}; later effects are unknown.`);
          const scope = kind === 'temp' ? 'temps' : current.scope;
          let expression = assignment[2] || '', read;
          if (kind === 'set' && /^(?:%[+-]|[+\-*/&])/.test(expression)) expression = name + ' ' + expression;
          read = !expression && kind === 'temp' ? { known: true, value: null } : readExpression(target, expression, at);
          if (!read.known || !['string', 'number', 'boolean'].includes(typeof read.value) && read.value !== null) return stop(`Cannot resolve *${kind} ${data} at line ${at + 1}; later effects are unknown.`);
          const before = Object.hasOwn(target[scope], name) ? copy(target[scope][name]) : undefined;
          target[scope][name] = read.value;
          effects.push({ kind, name, scope, before, after: read.value, source: text, line: at + 1 });
        } else if (kind === 'achieve') {
          effects.push({ kind, source: text, line: at + 1 });
        } else if (/^(goto|goto_scene|gosub|gosub_scene|return|finish|ending|abort|bug|restart|page_break|choice|fake_choice|input_text|input_number|redirect|delay_break|advertisement|restore_game|restore_password)$/i.test(kind)) {
          effects.push({ kind: 'flow', source: text, line: at + 1 });
          return stop('Preview stops here; effects after this jump, call, or interaction are not followed.');
        } else if (kind === 'rand' || kind === 'script') {
          return stop(`${text} (line ${at + 1}): ${kind === 'rand' ? 'random outcome' : 'scripted effects'} not predicted. Later effects are unknown.`);
        } else if (/^(print|line_break|image|sound|link|link_button|label|stat_chart|text_image|youtube)$/i.test(kind)) {
          // Display commands do not need to run to preview variable changes.
          if (kind === 'stat_chart') { at = blockEnd(at, last); continue; }
        } else return stop(`*${kind} at line ${at + 1} is not previewed. Later effects are unknown.`);
        at++;
      }
      return true;
    }
    walk(from, to);
    return { effects, effectNotes };
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
  function parse(from, to, inherited, groupIndex) {
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
          else if (!previous.length) notes.add('A conditional branch could not be matched to its preceding *if.');
          if (kind !== 'if') {
            const result = previous.some(item => item.result === true) ? false : previous.every(item => item.result === false) ? true : null;
            conditions.push({ ...condition('earlier branches', previous.map(item => `not (${item.expression})`).join(' and ') || 'unknown', at, result), values: [...new Map(previous.flatMap(item => item.values).map(value => [value.name, value])).values()] });
          }
          if (kind !== 'else') { const test = condition(kind, data, at); conditions.push(test); branches.push(test); }
          boundaries.add(at);
          options.push(...parse(at + 1, end, conditions, groupIndex)); at = end; continue;
        }
      } else branches = [];
      if (/^\*print\s+/i.test(text)) {
        try { shadow.lineNum = at; text = String(shadow.evaluateExpr(shadow.tokenizeExpr(text.replace(/^\*print\s+/i, '')))); }
        catch { notes.add('A generated option could not be inspected.'); }
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
        const entry = { option, name: original?.name || name, conditions, availability: hidden ? 'hidden' : disabled ? 'disabled' : 'available' };
        if (groupIndex + 1 < groups.length) entry.children = parse(at + 1, end, conditions, groupIndex + 1);
        else Object.assign(entry, previewEffects(at + 1, end));
        options.push(entry);
      } else if (!/^\*comment\b/i.test(text)) notes.add('Some option syntax could not be inspected; the original choices remain available when debug mode is off.');
      at = end;
    }
    return options;
  }
  const options = parse(startLine + 1, limit, [], 0), inspected = new Set();
  function collect(entries) { for (const entry of entries) { inspected.add(entry.option.line - 1); if (entry.children) collect(entry.children); } }
  collect(options);
  for (const [line, option] of existing) if (!inspected.has(line) && !option.suboptions?.length) {
    const conditions = [...(option.displayIf || []).map(expression => condition('if', expression, line)), ...(option.selectableIf ? [condition('selectable_if', option.selectableIf, line)] : [])];
    options.push({ option, name: option.name, conditions, availability: option.unselectable ? 'disabled' : 'available', effects: [], effectNotes: ['Effect preview unavailable for this generated option.'] });
  }
  return { options, boundaries: [...boundaries], choiceEnd: last, notes: [...notes] };
}
