// The two free Live models. Figures come from measurements made on the free
// tier (October 2026): see README.md.
export const DEFAULT_ENGINES = [
  {
    id: 'live',
    glyph: 'Ա',
    label: 'Gemini 3.8 Live',
    model: 'gemini-3.8-live',
    enabled: true,
    speaks: false, // answers with the function call alone, in ~2 s
    thinkingLevel: '', // this model rejects any thinking setting
    tpm: 65000,
    batchSize: 30,
    maxInputTokens: 3500,
    startConc: 3,
    maxConc: 6,
    overhead: 1050,
    timeoutMs: 40000,
  },
  {
    id: 'think',
    glyph: 'Բ',
    label: 'Gemini 3.8 Live Extended Thinking',
    model: 'gemini-3.8-live-extended-thinking',
    enabled: true,
    speaks: true, // must say a word before calling the function, 6–30 s
    thinkingLevel: 'low', // low | medium | high (minimal is refused)
    tpm: 65000,
    batchSize: 40,
    maxInputTokens: 5000,
    startConc: 2,
    maxConc: 4,
    overhead: 3400,
    timeoutMs: 75000,
  },
];

export function buildLanes(keys, engines) {
  const lanes = [];
  keys.forEach((key, k) => {
    for (const engine of engines) {
      if (!engine.enabled) continue;
      lanes.push({
        id: `${engine.id}:${k}`,
        key,
        keyLabel: keys.length > 1 ? `key ${k + 1}` : '',
        engine,
      });
    }
  });
  return lanes;
}
