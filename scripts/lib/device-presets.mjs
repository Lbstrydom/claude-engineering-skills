import { pathToFileURL } from 'node:url';

// Shared device-emulation presets for /persona-test and /click-test.
//
// Why this module exists: Playwright MCP exposes `browser_resize` but no
// device-emulation tool. Without a shared resolver, "mobile-first" personas
// silently run in 1280×720 desktop viewports — exactly the failure class
// the VS Code 1.122 integrated-browser feature highlighted. This module is
// the single source of truth so both skills agree on what "mobile" means.
//
// What it does NOT do: real touch-event emulation, UA-string injection at
// the network layer, or DPR-correct rendering. Those require Playwright
// launch-options (context-level) which the MCP doesn't expose. For full
// device emulation, use /persona-test --mode consistency (code-driven
// Playwright). For exploratory testing, viewport-only emulation catches
// ~80% of mobile/tablet regressions (responsive layouts, narrow-width
// overflow, mobile-only CTAs, touch-target sizing).

export const DEVICE_PRESETS = {
  desktop: {
    name: 'desktop',
    viewport: { width: 1280, height: 720 },
    userAgent: null,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  'desktop-large': {
    name: 'desktop-large',
    viewport: { width: 1920, height: 1080 },
    userAgent: null,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  tablet: {
    name: 'tablet',
    viewport: { width: 768, height: 1024 },
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  mobile: {
    name: 'mobile',
    viewport: { width: 390, height: 844 },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 ' +
      'Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'mobile-small': {
    name: 'mobile-small',
    viewport: { width: 360, height: 640 },
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
  },
};

export const DEFAULT_PRESET = 'desktop';

// Order matters — longer / more specific phrases must match before shorter
// fallbacks. The first regex that matches wins.
const RESOLVER_PATTERNS = [
  { pattern: /\b(mobile[-\s]?small|older[-\s]?phone|cheap[-\s]?android|low[-\s]?end[-\s]?phone)\b/i, preset: 'mobile-small' },
  { pattern: /\b(mobile[-\s]?first|iphone|android[-\s]?phone|smartphone|phone[-\s]?user|on[-\s]?(?:my|a|the|their|his|her|your)[-\s]?phone|small[-\s]?screen)\b/i, preset: 'mobile' },
  { pattern: /\b(tablet|ipad)\b/i, preset: 'tablet' },
  { pattern: /\b(large[-\s]?desktop|big[-\s]?screen|wide[-\s]?monitor|4k|ultra[-\s]?wide)\b/i, preset: 'desktop-large' },
  { pattern: /\b(desktop[-\s]?first|on[-\s]?(?:my|a|the|their|his|her|your)[-\s]?(?:desktop|laptop)|laptop[-\s]?user)\b/i, preset: 'desktop' },
];

export function resolveDevicePreset(description, fallback = DEFAULT_PRESET) {
  if (!description || typeof description !== 'string') {
    return { ...DEVICE_PRESETS[fallback], resolvedFrom: 'fallback' };
  }
  for (const { pattern, preset } of RESOLVER_PATTERNS) {
    const match = description.match(pattern);
    if (match) {
      return { ...DEVICE_PRESETS[preset], resolvedFrom: 'description', matched: match[0].toLowerCase() };
    }
  }
  return { ...DEVICE_PRESETS[fallback], resolvedFrom: 'fallback' };
}

export function getPreset(name) {
  if (!Object.prototype.hasOwnProperty.call(DEVICE_PRESETS, name)) {
    const valid = Object.keys(DEVICE_PRESETS).join(', ');
    throw new Error(`Unknown device preset "${name}". Valid presets: ${valid}`);
  }
  return { ...DEVICE_PRESETS[name], resolvedFrom: 'explicit' };
}

export function listPresets() {
  return Object.keys(DEVICE_PRESETS);
}

export function parseViewportFlag(value) {
  const m = /^(\d+)x(\d+)$/i.exec(value ?? '');
  if (!m) throw new Error(`Invalid viewport "${value}". Expected WxH (e.g. 390x844).`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 320 || width > 4096 || height < 320 || height > 4096) {
    throw new Error(`Viewport "${value}" out of range. Width and height must be in [320, 4096].`);
  }
  return {
    name: 'custom',
    viewport: { width, height },
    userAgent: null,
    deviceScaleFactor: 1,
    isMobile: width < 768,
    hasTouch: width < 768,
    resolvedFrom: 'viewport-flag',
  };
}

export function parseDevicesFlag(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('Invalid --devices value (expected comma-separated preset names).');
  }
  const names = value.split(',').map(s => s.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new Error('Invalid --devices value (no preset names found).');
  }
  const seen = new Set();
  const presets = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    presets.push(getPreset(n));
  }
  return presets;
}

// ─────────────────────────────────────────────────────────────────────
// Runner-enforcement helpers — produce a structured "contract" the
// SKILL.md instructs the LLM to consume verbatim. Removes LLM judgement
// from device selection (the LLM still drives the actual MCP calls,
// but the WHAT is predetermined). Keeps device emulation deterministic.

const PERSONA_TEST_PREP_VERSION = 1;
const CLICK_TEST_PREP_VERSION = 1;

function formatLogLine(device, suffix = '') {
  const matched = device.matched ?? device.resolvedFrom ?? 'fallback';
  const tag = suffix ? ` [${suffix}]` : '';
  return `[device-profile] ${matched} → ${device.name} (${device.viewport.width}x${device.viewport.height}, touch=${device.hasTouch})${tag}`;
}

function buildResizeCall(device) {
  return {
    tool: 'browser_resize',
    args: { width: device.viewport.width, height: device.viewport.height },
  };
}

export function prepPersonaTest({ description, overridePreset } = {}) {
  const device = overridePreset
    ? getPreset(overridePreset)
    : resolveDevicePreset(description ?? '');
  return {
    kind: 'persona-test-prep',
    version: PERSONA_TEST_PREP_VERSION,
    device,
    expectedFirstMcpCall: buildResizeCall(device),
    personaMentalModelTags: device.isMobile
      ? ['mobile-viewport', 'thumb-reach', 'one-handed', 'distracted-attention', 'slow-network-assumption']
      : [],
    logLine: formatLogLine(device),
  };
}

export function prepClickTest({ devicePreset, devicesList, viewport } = {}) {
  const provided = [devicePreset, devicesList, viewport].filter(v => v !== undefined && v !== null && v !== '').length;
  if (provided > 1) {
    throw new Error('Pick at most one of --device, --devices, or --viewport (they are mutually exclusive).');
  }
  let presets;
  if (devicesList) {
    presets = parseDevicesFlag(devicesList);
  } else if (devicePreset) {
    presets = [getPreset(devicePreset)];
  } else if (viewport) {
    presets = [parseViewportFlag(viewport)];
  } else {
    presets = [getPreset(DEFAULT_PRESET)];
  }
  const totalPasses = presets.length;
  return {
    kind: 'click-test-prep',
    version: CLICK_TEST_PREP_VERSION,
    matrixMode: totalPasses > 1,
    totalPasses,
    passes: presets.map((device, idx) => ({
      passIndex: idx,
      device,
      expectedFirstMcpCall: buildResizeCall(device),
      logLine: formatLogLine(device, `pass ${idx + 1}/${totalPasses}`),
    })),
  };
}

function parseCliFlag(argv, name) {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  try {
    if (sub === 'list') {
      for (const name of listPresets()) {
        const p = DEVICE_PRESETS[name];
        process.stdout.write(`${name.padEnd(15)} ${p.viewport.width}x${p.viewport.height}  touch=${p.hasTouch}\n`);
      }
    } else if (sub === 'resolve') {
      process.stdout.write(JSON.stringify(resolveDevicePreset(rest.join(' ')), null, 2) + '\n');
    } else if (sub === 'get') {
      process.stdout.write(JSON.stringify(getPreset(rest[0]), null, 2) + '\n');
    } else if (sub === 'prep') {
      const overridePreset = parseCliFlag(rest, 'device');
      const description = rest.filter((tok, i) => tok !== '--device' && rest[i - 1] !== '--device').join(' ');
      process.stdout.write(JSON.stringify(prepPersonaTest({ description, overridePreset }), null, 2) + '\n');
    } else if (sub === 'prep-matrix') {
      process.stdout.write(JSON.stringify(prepClickTest({
        devicePreset: parseCliFlag(rest, 'device'),
        devicesList: parseCliFlag(rest, 'devices'),
        viewport: parseCliFlag(rest, 'viewport'),
      }), null, 2) + '\n');
    } else {
      process.stderr.write('Usage:\n');
      process.stderr.write('  node scripts/lib/device-presets.mjs list\n');
      process.stderr.write('  node scripts/lib/device-presets.mjs resolve "<persona description>"\n');
      process.stderr.write('  node scripts/lib/device-presets.mjs get <preset-name>\n');
      process.stderr.write('  node scripts/lib/device-presets.mjs prep "<persona description>" [--device <preset>]\n');
      process.stderr.write('  node scripts/lib/device-presets.mjs prep-matrix [--device <preset>] [--devices "<list>"] [--viewport <WxH>]\n');
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(2);
  }
}
