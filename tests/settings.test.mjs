import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings, readerStyles, resolvedTheme } from '../src/settings.js';

test('settings accept supported values and reject invalid limits, fonts and CSS injection', () => {
  assert.equal(normalizeSettings({ autosaveLimit: 0 }, true).autosaveLimit, 0);
  assert.equal(normalizeSettings({ autosaveLimit: 100, fontSize: 32, lineHeight: 2.2 }, true).fontSize, 32);
  for (const input of [{ autosaveLimit: -1 }, { autosaveLimit: 101 }, { autosaveLimit: 1.5 }, { fontSize: 200 }, { fontSize: '18px' }, { lineHeight: NaN }, { lineHeight: Infinity }, { lineHeight: -Infinity }, { theme: 'dark;}' }, { fontFamily: 'url(https://example.com)' }, { reduceMotion: 'true' }]) {
    assert.throws(() => normalizeSettings(input, true), /valid value/);
    assert.deepEqual(normalizeSettings(input), DEFAULT_SETTINGS);
  }
});

test('reader appearance resolves the device theme, controls typography and can restore game styling', () => {
  assert.equal(resolvedTheme(DEFAULT_SETTINGS, true), 'dark');
  assert.equal(resolvedTheme({ theme: 'light' }, true), 'light');
  const css = readerStyles({ theme: 'dark', fontFamily: 'sans', fontSize: 24, lineHeight: 1.8, readerWidth: 'wide', reduceMotion: true });
  assert.match(css, /color-scheme:dark!important/);
  assert.match(css, /font-size:24px!important/);
  assert.match(css, /font-family:system-ui/);
  assert.match(css, /max-width:900px!important/);
  assert.match(css, /line-height:1.8!important/);
  assert.match(css, /animation-duration:\.01ms!important/);
  assert.equal(readerStyles({ useGameAppearance: true }), '');
  assert.match(readerStyles({ useGameAppearance: true, reduceMotion: true }), /animation-duration:\.01ms/);
  assert.match(readerStyles({ theme: 'system' }, true), /color-scheme:dark/);
});
