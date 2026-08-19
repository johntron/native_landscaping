import { GLOBAL_SEED } from '../constants.js';

const MODULUS = 0x100000000; // 2^32
const MULTIPLIER = 1664525;
const INCREMENT = 1013904223;
const DEFAULT_STATE = 1;

export function makeRng(seed = GLOBAL_SEED) {
  let state = normalizeSeed(seed);

  const next = () => {
    state = (MULTIPLIER * state + INCREMENT) % MODULUS;
    return state / MODULUS;
  };

  return { next };
}

export function hashStringToSeed(value) {
  let hash = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function seedForPlant(id) {
  return normalizeSeed(GLOBAL_SEED ^ hashStringToSeed(String(id)));
}

function normalizeSeed(rawSeed) {
  const normalized = rawSeed >>> 0;
  return normalized === 0 ? DEFAULT_STATE : normalized;
}
