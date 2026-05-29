import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_PRESETS,
  DEFAULT_PRESET,
  resolveDevicePreset,
  getPreset,
  listPresets,
  parseViewportFlag,
  parseDevicesFlag,
  prepPersonaTest,
  prepClickTest,
} from '../scripts/lib/device-presets.mjs';

describe('device-presets — registry shape', () => {
  it('exposes the five canonical presets', () => {
    assert.deepEqual(
      listPresets().sort(),
      ['desktop', 'desktop-large', 'mobile', 'mobile-small', 'tablet'].sort()
    );
  });

  it('every preset has the required fields', () => {
    for (const name of listPresets()) {
      const p = DEVICE_PRESETS[name];
      assert.equal(typeof p.name, 'string');
      assert.equal(typeof p.viewport.width, 'number');
      assert.equal(typeof p.viewport.height, 'number');
      assert.ok(p.viewport.width >= 320 && p.viewport.width <= 4096);
      assert.ok(p.viewport.height >= 320 && p.viewport.height <= 4096);
      assert.equal(typeof p.isMobile, 'boolean');
      assert.equal(typeof p.hasTouch, 'boolean');
    }
  });

  it('mobile presets have touch + isMobile', () => {
    assert.equal(DEVICE_PRESETS.mobile.isMobile, true);
    assert.equal(DEVICE_PRESETS.mobile.hasTouch, true);
    assert.equal(DEVICE_PRESETS['mobile-small'].isMobile, true);
    assert.equal(DEVICE_PRESETS.tablet.hasTouch, true);
  });

  it('desktop presets do not have touch', () => {
    assert.equal(DEVICE_PRESETS.desktop.hasTouch, false);
    assert.equal(DEVICE_PRESETS['desktop-large'].hasTouch, false);
  });
});

describe('device-presets — resolveDevicePreset', () => {
  it('resolves "mobile-first" to mobile', () => {
    const r = resolveDevicePreset('wine enthusiast, 40s, drinks daily, mobile-first');
    assert.equal(r.name, 'mobile');
    assert.equal(r.resolvedFrom, 'description');
  });

  it('resolves "on my phone" to mobile', () => {
    const r = resolveDevicePreset('Casual user, usually browses on their phone in bed');
    assert.equal(r.name, 'mobile');
  });

  it('resolves "iPhone" to mobile', () => {
    const r = resolveDevicePreset('iPhone 13 user');
    assert.equal(r.name, 'mobile');
  });

  it('resolves "older phone" to mobile-small', () => {
    const r = resolveDevicePreset('Sticks with an older phone, low-end Android');
    assert.equal(r.name, 'mobile-small');
  });

  it('resolves "tablet" to tablet', () => {
    const r = resolveDevicePreset('Tablet user, prefers reading mode');
    assert.equal(r.name, 'tablet');
  });

  it('resolves "iPad" to tablet', () => {
    const r = resolveDevicePreset('Reads on her iPad at night');
    assert.equal(r.name, 'tablet');
  });

  it('resolves "desktop-first" to desktop', () => {
    const r = resolveDevicePreset('Desktop-first power user, three monitors');
    assert.equal(r.name, 'desktop');
  });

  it('resolves "ultrawide" to desktop-large', () => {
    const r = resolveDevicePreset('Has an ultrawide monitor, 4K');
    assert.equal(r.name, 'desktop-large');
  });

  it('falls back to desktop for no cue', () => {
    const r = resolveDevicePreset('Admin power user with deep domain knowledge');
    assert.equal(r.name, 'desktop');
    assert.equal(r.resolvedFrom, 'fallback');
  });

  it('falls back to desktop for empty/null input', () => {
    assert.equal(resolveDevicePreset('').name, 'desktop');
    assert.equal(resolveDevicePreset(null).name, 'desktop');
    assert.equal(resolveDevicePreset(undefined).name, 'desktop');
  });

  it('honours custom fallback', () => {
    const r = resolveDevicePreset('no device cue here', 'tablet');
    assert.equal(r.name, 'tablet');
  });

  it('prefers mobile-small over mobile when both could match', () => {
    const r = resolveDevicePreset('Cheap-android user, mobile-first');
    assert.equal(r.name, 'mobile-small');
  });

  it('is deterministic — same input gives same output', () => {
    const a = resolveDevicePreset('mobile-first wine enthusiast');
    const b = resolveDevicePreset('mobile-first wine enthusiast');
    assert.deepEqual(a, b);
  });
});

describe('device-presets — getPreset', () => {
  it('returns a preset by name', () => {
    const p = getPreset('mobile');
    assert.equal(p.name, 'mobile');
    assert.equal(p.resolvedFrom, 'explicit');
  });

  it('throws on unknown preset', () => {
    assert.throws(() => getPreset('not-a-real-preset'), /Unknown device preset/);
  });

  it('error message lists valid presets', () => {
    try {
      getPreset('bogus');
    } catch (e) {
      assert.match(e.message, /desktop/);
      assert.match(e.message, /mobile/);
    }
  });
});

describe('device-presets — parseViewportFlag', () => {
  it('parses a valid WxH string', () => {
    const p = parseViewportFlag('390x844');
    assert.equal(p.viewport.width, 390);
    assert.equal(p.viewport.height, 844);
    assert.equal(p.name, 'custom');
    assert.equal(p.resolvedFrom, 'viewport-flag');
  });

  it('infers isMobile/hasTouch from narrow widths', () => {
    const narrow = parseViewportFlag('390x844');
    assert.equal(narrow.isMobile, true);
    assert.equal(narrow.hasTouch, true);

    const wide = parseViewportFlag('1280x720');
    assert.equal(wide.isMobile, false);
    assert.equal(wide.hasTouch, false);
  });

  it('rejects malformed strings', () => {
    assert.throws(() => parseViewportFlag('1280'), /Invalid viewport/);
    assert.throws(() => parseViewportFlag('axb'), /Invalid viewport/);
    assert.throws(() => parseViewportFlag(''), /Invalid viewport/);
  });

  it('rejects out-of-range dimensions', () => {
    assert.throws(() => parseViewportFlag('100x100'), /out of range/);
    assert.throws(() => parseViewportFlag('5000x5000'), /out of range/);
  });
});

describe('device-presets — parseDevicesFlag', () => {
  it('parses a comma list', () => {
    const presets = parseDevicesFlag('desktop,mobile');
    assert.equal(presets.length, 2);
    assert.equal(presets[0].name, 'desktop');
    assert.equal(presets[1].name, 'mobile');
  });

  it('deduplicates', () => {
    const presets = parseDevicesFlag('mobile,mobile,desktop');
    assert.equal(presets.length, 2);
  });

  it('trims whitespace', () => {
    const presets = parseDevicesFlag(' desktop , mobile ');
    assert.equal(presets.length, 2);
  });

  it('throws on unknown preset', () => {
    assert.throws(() => parseDevicesFlag('desktop,foo'), /Unknown device preset/);
  });

  it('throws on empty input', () => {
    assert.throws(() => parseDevicesFlag(''), /Invalid --devices/);
    assert.throws(() => parseDevicesFlag(null), /Invalid --devices/);
  });
});

describe('device-presets — DEFAULT_PRESET', () => {
  it('is desktop', () => {
    assert.equal(DEFAULT_PRESET, 'desktop');
  });
});

describe('runner enforcement — prepPersonaTest', () => {
  it('resolves device from description and emits the resize call', () => {
    const contract = prepPersonaTest({ description: 'Pieter, wine enthusiast, mobile-first' });
    assert.equal(contract.kind, 'persona-test-prep');
    assert.equal(contract.version, 1);
    assert.equal(contract.device.name, 'mobile');
    assert.deepEqual(contract.expectedFirstMcpCall, {
      tool: 'browser_resize',
      args: { width: 390, height: 844 },
    });
  });

  it('override beats description', () => {
    const contract = prepPersonaTest({
      description: 'mobile-first user',
      overridePreset: 'tablet',
    });
    assert.equal(contract.device.name, 'tablet');
    assert.equal(contract.device.resolvedFrom, 'explicit');
    assert.equal(contract.expectedFirstMcpCall.args.width, 768);
  });

  it('mobile device → tags the persona mental model', () => {
    const contract = prepPersonaTest({ description: 'on her iPhone' });
    assert.ok(contract.personaMentalModelTags.includes('mobile-viewport'));
    assert.ok(contract.personaMentalModelTags.includes('thumb-reach'));
  });

  it('desktop device → no mobile tags', () => {
    const contract = prepPersonaTest({ description: 'desktop power user' });
    assert.deepEqual(contract.personaMentalModelTags, []);
  });

  it('logLine starts with [device-profile]', () => {
    const contract = prepPersonaTest({ description: 'mobile-first' });
    assert.match(contract.logLine, /^\[device-profile\]/);
    assert.match(contract.logLine, /mobile/);
    assert.match(contract.logLine, /touch=true/);
  });

  it('handles empty/missing description with desktop fallback', () => {
    const contract = prepPersonaTest({});
    assert.equal(contract.device.name, 'desktop');
    assert.equal(contract.expectedFirstMcpCall.args.width, 1280);
  });

  it('rejects unknown override preset', () => {
    assert.throws(
      () => prepPersonaTest({ description: 'x', overridePreset: 'phablet' }),
      /Unknown device preset/
    );
  });

  it('contract is deterministic for the same input', () => {
    const a = prepPersonaTest({ description: 'mobile-first wine enthusiast' });
    const b = prepPersonaTest({ description: 'mobile-first wine enthusiast' });
    assert.deepEqual(a, b);
  });
});

describe('runner enforcement — prepClickTest', () => {
  it('no flags → single desktop pass', () => {
    const contract = prepClickTest({});
    assert.equal(contract.kind, 'click-test-prep');
    assert.equal(contract.version, 1);
    assert.equal(contract.matrixMode, false);
    assert.equal(contract.totalPasses, 1);
    assert.equal(contract.passes[0].device.name, 'desktop');
    assert.equal(contract.passes[0].passIndex, 0);
  });

  it('--device mobile → single mobile pass', () => {
    const contract = prepClickTest({ devicePreset: 'mobile' });
    assert.equal(contract.matrixMode, false);
    assert.equal(contract.passes[0].device.name, 'mobile');
  });

  it('--devices "desktop,mobile" → matrix with 2 passes', () => {
    const contract = prepClickTest({ devicesList: 'desktop,mobile' });
    assert.equal(contract.matrixMode, true);
    assert.equal(contract.totalPasses, 2);
    assert.equal(contract.passes[0].device.name, 'desktop');
    assert.equal(contract.passes[1].device.name, 'mobile');
    assert.equal(contract.passes[0].passIndex, 0);
    assert.equal(contract.passes[1].passIndex, 1);
  });

  it('--viewport WxH → single custom pass', () => {
    const contract = prepClickTest({ viewport: '390x844' });
    assert.equal(contract.matrixMode, false);
    assert.equal(contract.passes[0].device.name, 'custom');
    assert.equal(contract.passes[0].device.viewport.width, 390);
  });

  it('every pass has an expectedFirstMcpCall', () => {
    const contract = prepClickTest({ devicesList: 'desktop,mobile,tablet' });
    for (const pass of contract.passes) {
      assert.equal(pass.expectedFirstMcpCall.tool, 'browser_resize');
      assert.equal(pass.expectedFirstMcpCall.args.width, pass.device.viewport.width);
      assert.equal(pass.expectedFirstMcpCall.args.height, pass.device.viewport.height);
    }
  });

  it('logLine includes pass index for matrix mode', () => {
    const contract = prepClickTest({ devicesList: 'desktop,mobile' });
    assert.match(contract.passes[0].logLine, /pass 1\/2/);
    assert.match(contract.passes[1].logLine, /pass 2\/2/);
  });

  it('throws when --device + --devices both passed', () => {
    assert.throws(
      () => prepClickTest({ devicePreset: 'mobile', devicesList: 'desktop' }),
      /mutually exclusive/
    );
  });

  it('throws when --device + --viewport both passed', () => {
    assert.throws(
      () => prepClickTest({ devicePreset: 'mobile', viewport: '800x600' }),
      /mutually exclusive/
    );
  });

  it('throws when --devices + --viewport both passed', () => {
    assert.throws(
      () => prepClickTest({ devicesList: 'mobile', viewport: '800x600' }),
      /mutually exclusive/
    );
  });

  it('contract is deterministic for the same input', () => {
    const a = prepClickTest({ devicesList: 'desktop,mobile' });
    const b = prepClickTest({ devicesList: 'desktop,mobile' });
    assert.deepEqual(a, b);
  });
});
