#!/usr/bin/env node
/**
 * @fileoverview Thompson Sampling bandit for prompt variant selection.
 * Pure JS implementation — no external dependencies.
 * @module scripts/bandit
 */

import fs from 'fs';
import path from 'path';

// ── Pure JS Beta distribution sampling ──────────────────────────────────────

/** Standard normal random variate (Box-Muller). */
function randn() {
  let u1;
  do { u1 = Math.random(); } while (u1 === 0); // Avoid log(0)
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Gamma random variate (Marsaglia-Tsang). */
function randomGamma(shape) {
  if (shape < 1) return randomGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  const d = shape - 1/3, c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do { x = randn(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta random variate via Gamma decomposition. */
function randomBeta(alpha, beta) {
  const g1 = randomGamma(alpha);
  const g2 = randomGamma(beta);
  return g1 / (g1 + g2);
}

// ── Prompt Bandit ───────────────────────────────────────────────────────────

export class PromptBandit {
  constructor(statePath = '.audit/bandit-state.json') {
    this.statePath = path.resolve(statePath);
    this.arms = this._load();
  }

  /** Register a prompt variant as an arm. */
  addArm(passName, variantId, metadata = {}) {
    const key = `${passName}:${variantId}`;
    if (!this.arms[key]) {
      this.arms[key] = { alpha: 1, beta: 1, pulls: 0, passName, variantId, ...metadata };
      this._save();
    }
  }

  /** Select the best arm for a pass using Thompson Sampling. */
  select(passName) {
    const candidates = Object.entries(this.arms)
      .filter(([, arm]) => arm.passName === passName);

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0][1]; // Only one option

    let best = null, bestSample = -1;
    for (const [, arm] of candidates) {
      const sample = randomBeta(arm.alpha, arm.beta);
      if (sample > bestSample) { bestSample = sample; best = arm; }
    }
    return best;
  }

  /** Update arm after observing outcome. */
  update(passName, variantId, reward) {
    const key = `${passName}:${variantId}`;
    const arm = this.arms[key];
    if (!arm) return;

    // Reward can be binary (0/1) or continuous (0-1)
    if (reward > 0.5) arm.alpha += reward;
    else arm.beta += (1 - reward);
    arm.pulls++;
    this._save();
  }

  /** Check if a winning arm has been identified (95% CI separation). */
  hasConverged(passName) {
    const candidates = Object.entries(this.arms)
      .filter(([, arm]) => arm.passName === passName);
    if (candidates.length < 2) return true;

    const sorted = candidates.sort((a, b) => {
      const aRate = b[1].alpha / (b[1].alpha + b[1].beta);
      const bRate = a[1].alpha / (a[1].alpha + a[1].beta);
      return aRate - bRate;
    });

    const bestArm = sorted[0][1];
    if (bestArm.pulls < 10) return false; // Need minimum observations

    // Simple convergence: best arm's mean - 2*stderr > second arm's mean + 2*stderr
    const bestMean = bestArm.alpha / (bestArm.alpha + bestArm.beta);
    const bestVar = (bestArm.alpha * bestArm.beta) / ((bestArm.alpha + bestArm.beta) ** 2 * (bestArm.alpha + bestArm.beta + 1));
    const secondArm = sorted[1][1];
    const secondMean = secondArm.alpha / (secondArm.alpha + secondArm.beta);
    const secondVar = (secondArm.alpha * secondArm.beta) / ((secondArm.alpha + secondArm.beta) ** 2 * (secondArm.alpha + secondArm.beta + 1));

    return bestMean - 2 * Math.sqrt(bestVar) > secondMean + 2 * Math.sqrt(secondVar);
  }

  /** Get stats for all arms. */
  getStats() {
    return Object.values(this.arms).map(a => ({
      pass: a.passName,
      variant: a.variantId,
      estimatedRate: (a.alpha / (a.alpha + a.beta)).toFixed(3),
      pulls: a.pulls,
      alpha: a.alpha,
      beta: a.beta
    })).sort((a, b) => parseFloat(b.estimatedRate) - parseFloat(a.estimatedRate));
  }

  _load() {
    try {
      if (fs.existsSync(this.statePath)) return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
    } catch { /* */ }
    return {};
  }

  _save() {
    // Debounce: defer write by 100ms to coalesce rapid updates from parallel passes
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        fs.writeFileSync(this.statePath, JSON.stringify(this.arms, null, 2), 'utf-8');
      } catch (err) {
        process.stderr.write(`  [bandit] Save failed: ${err.message}\n`);
      }
    }, 100);
  }

  /** Force immediate save (call at end of audit). */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.arms, null, 2), 'utf-8');
    } catch (err) {
      process.stderr.write(`  [bandit] Flush failed: ${err.message}\n`);
    }
  }
}

/** Compute weighted reward from deliberation outcome (RLHF-lite). */
export function computeReward(resolution) {
  const positionWeights = { accept: 1.0, partial_accept: 0.6, challenge: 0.0 };
  const rulingWeights = { sustain: 1.0, compromise: 0.5, overrule: 0.0 };
  const severityMult = { HIGH: 1.0, MEDIUM: 0.7, LOW: 0.4 };

  const claudeSignal = positionWeights[resolution.claude_position] ?? 0;
  const gptSignal = rulingWeights[resolution.gpt_ruling] ?? 0;
  const sevMult = severityMult[resolution.final_severity] ?? 0;

  return (claudeSignal * 0.4 + gptSignal * 0.6) * sevMult;
}

// CLI interface
if (process.argv[1]?.endsWith('bandit.mjs')) {
  const cmd = process.argv[2];
  const bandit = new PromptBandit();

  if (cmd === 'add') {
    const pass = process.argv[3];
    const variant = process.argv[4];
    if (!pass || !variant) {
      console.log('Usage: node scripts/bandit.mjs add <pass-name> <variant-id>');
      process.exit(1);
    }
    bandit.addArm(pass, variant);
    console.log(`Registered arm: ${pass}:${variant}`);
    process.exit(0);
  }

  if (cmd === 'stats') {
    const stats = bandit.getStats();
    if (stats.length === 0) {
      console.log('No bandit arms registered. Arms are created when prompt variants are used.');
    } else {
      console.log('Arm                          | Rate  | Pulls | Converged');
      console.log('-'.repeat(60));
      for (const s of stats) {
        const converged = bandit.hasConverged(s.pass) ? 'Y' : '';
        console.log(`${(s.pass+':'+s.variant).padEnd(29)}| ${s.estimatedRate} | ${String(s.pulls).padStart(5)} | ${converged}`);
      }
    }
  } else {
    console.log('Usage: node scripts/bandit.mjs stats');
    console.log('       node scripts/bandit.mjs add <pass-name> <variant-id>');
  }
}
