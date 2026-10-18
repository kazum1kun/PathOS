// Serialized into the game frame alongside the runtime. Inspect source without
// executing option bodies or changing the live scene's variables or position.
export function inspectChoiceBlock(scene, startLine, groups, renderedOptions) {
  const lines = scene.lines || [];
  const existing = new Map(), boundaries = new Set();
  function index(options) { for (const option of options || []) { existing.set(option.line - 1, option); index(option.suboptions); } }
  index(renderedOptions);
  const copy = value => JSON.parse(JSON.stringify(value));
  const shadow = Object.assign(Object.create(Object.getPrototypeOf(scene)), scene);
  const stats = { ...scene.stats }; delete stats.scene;
  shadow.stats = copy(stats); shadow.stats.scene = shadow;
  shadow.temps = copy(scene.temps || {});
  shadow.debugMode = false;
  const startIndent = shadow.getIndent(lines[startLine] || '');
  const notes = new Set();
  function evaluate(expression, line) {
    try {
      shadow.lineNum = line;
      const value = shadow.evaluateExpr(shadow.tokenizeExpr(expression));
      return typeof value === 'boolean' ? value : null;
    } catch { return null; }
  }
  function condition(kind, expression, line, result = evaluate(expression, line)) { return { kind, expression, line: line + 1, result }; }
  function indent(at) { shadow.lineNum = at; return shadow.getIndent(lines[at]); }
  function blockEnd(at, limit) { let next = at + 1; while (next < limit && (!lines[next].trim() || indent(next) > indent(at))) next++; return next; }
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
            conditions.push(condition('earlier branches', previous.map(item => `not (${item.expression})`).join(' and ') || 'unknown', at, result));
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
        if (reuse !== 'allow') conditions.push(condition(`${reuse}_reuse`, 'not previously selected', at, !used));
        let name = text.replace(/^#\s*/, '');
        try { shadow.lineNum = at; name = shadow.replaceVariables(name); } catch { /* retain source when a hidden branch needs missing variables */ }
        const option = original || { name, group: groups[groupIndex] || 'choice', line: at + 1, endLine: end, ...(reuse !== 'allow' ? { reuse } : {}) };
        const hidden = !original || conditions.some(item => item.result === false && item.kind !== 'selectable_if' && item.kind !== 'disable_reuse');
        const disabled = !!original?.unselectable || conditions.some(item => item.result === false && (item.kind === 'selectable_if' || item.kind === 'disable_reuse'));
        const entry = { option, name: original?.name || name, conditions, availability: hidden ? 'hidden' : disabled ? 'disabled' : 'available' };
        if (groupIndex + 1 < groups.length) entry.children = parse(at + 1, end, conditions, groupIndex + 1);
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
    options.push({ option, name: option.name, conditions, availability: option.unselectable ? 'disabled' : 'available' });
  }
  return { options, boundaries: [...boundaries], choiceEnd: last, notes: [...notes] };
}
