export const SETTINGS_ID = 'pathos-settings';
export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system', autosaveLimit: 20, saveContinuations: false,
  fontFamily: 'serif', fontSize: 18, lineHeight: 1.65,
  readerWidth: 'comfortable', useGameAppearance: false, reduceMotion: false,
});
export const READER_FONTS = Object.freeze({
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
});
const choices = { theme: ['system', 'light', 'dark'], fontFamily: Object.keys(READER_FONTS), readerWidth: ['narrow', 'comfortable', 'wide', 'full'] };
const ranges = { autosaveLimit: [0, 100], fontSize: [14, 32], lineHeight: [1.2, 2.2] };
const labels = { theme: 'the color theme', autosaveLimit: 'the autosave limit (0–100)', saveContinuations: 'continuation autosaves', fontFamily: 'the reader font', fontSize: 'the font size (14–32)', lineHeight: 'line spacing (1.2–2.2)', readerWidth: 'the reading width', useGameAppearance: 'the game appearance option', reduceMotion: 'reduced motion' };
export function normalizeSettings(input = {}, strict = false) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(settings)) {
    const value = input?.[key];
    if (value === undefined) continue;
    const valid = choices[key] ? choices[key].includes(value)
      : ranges[key] ? typeof value === 'number' && value >= ranges[key][0] && value <= ranges[key][1] && (key === 'lineHeight' || Number.isInteger(value))
      : typeof value === 'boolean';
    if (!valid) { if (strict) throw new Error(`Choose a valid value for ${labels[key]}.`); continue; }
    settings[key] = value;
  }
  return settings;
}
export function resolvedTheme(settings, systemDark = false) {
  return settings.theme === 'system' ? systemDark ? 'dark' : 'light' : settings.theme;
}
export function readerStyles(input, systemDark = false) {
  const settings = normalizeSettings(input);
  // Keep completion events firing for engines that use them to advance pages.
  const motion = settings.reduceMotion ? '*{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}' : '';
  if (settings.useGameAppearance) return motion;
  const dark = resolvedTheme(settings, systemDark) === 'dark';
  const paper = dark ? '#1a1814' : '#fbf8f1', ink = dark ? '#ebe4d5' : '#1e1b16', accent = dark ? '#e0836f' : '#9e3326';
  const hover = dark ? '#302a22' : '#eee5d8', selected = dark ? '#49342a' : '#ead5c2', rule = dark ? '#706557' : '#b2a38d';
  const width = { narrow: '480px', comfortable: '680px', wide: '900px', full: 'none' }[settings.readerWidth];
  const font = READER_FONTS[settings.fontFamily];
  return `
html:root{color-scheme:${dark ? 'dark' : 'light'}!important;background:${paper}!important;color:${ink}!important;font-size:${settings.fontSize}px!important}
html:root body{box-sizing:border-box!important;width:100%!important;max-width:${width}!important;margin:0 auto!important;padding:clamp(16px,4vw,32px)!important;background:${paper}!important;color:${ink}!important;font-family:${font}!important;font-size:${settings.fontSize}px!important;line-height:${settings.lineHeight}!important;text-shadow:none!important}
html:root body :is(div,p,span,li,label,td,th,blockquote,section,article,button,input,select,textarea){font-family:${font}!important;font-size:inherit!important;line-height:${settings.lineHeight}!important;color:inherit!important;text-shadow:none!important}
html:root body :is(#container1,#container2,#main,#story,main){box-sizing:border-box!important;max-width:100%!important;width:100%!important;background-color:transparent!important;color:${ink}!important}
html:root body :is(h1,h2,h3,h4){font-family:${font}!important;color:${ink}!important;line-height:1.3!important}
html:root body h1{font-size:1.65em!important}html:root body h2{font-size:1.35em!important}
html:root body a{color:${accent}!important}
html:root body :is(button,input,select,textarea){background-color:${paper}!important;color:${ink}!important;border-color:${accent}!important;max-width:100%!important}
html:root body :is(button,input[type=button],input[type=submit],input[type=reset],.next){box-sizing:border-box!important;background-color:${paper}!important;color:${ink}!important;border:1px solid ${accent}!important;border-radius:4px!important;padding:.4em .75em}
html:root body :is(input[type=radio],input[type=checkbox]){accent-color:${accent}}
html:root body .choice>div{background-color:${paper}!important;color:${ink}!important;border-color:${rule}!important}
html:root body .choice label{background-color:transparent!important;color:inherit!important}
@media(hover:hover){
  html:root body .choice>div:where(:not(.disabled):hover),html:root body :is(button,input[type=button],input[type=submit],input[type=reset],.next):where(:not(:disabled):hover){background-color:${hover}!important;color:${ink}!important}
}
html:root body .choice>div:is(.selected,.selectedKeyboard,:focus-within),html:root body :is(button,.next).selectedKeyboard{background-color:${selected}!important;color:${ink}!important;box-shadow:inset 3px 0 ${accent}!important}
html:root body .choice>div:has(input[type=radio]:checked){background-color:${selected}!important;color:${ink}!important;box-shadow:inset 3px 0 ${accent}!important}
html:root body .choice .disabled{opacity:.55!important}
html:root body :is(button,input,select,textarea):disabled{opacity:.5!important;cursor:default!important}
html:root body :is(img,video){max-width:100%!important;height:auto}
html:root body :is(button,a,input,select,textarea):focus-visible{outline:2px solid ${accent}!important;outline-offset:3px}
${motion}`;
}
