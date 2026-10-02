// Which format a document is, decided on the model (the parsed source, before any script runs)
// because the edit preview's bootstrap depends on it.
import { isReveal, runtimeEvidence } from './reveal.mjs';

// { format: 'reveal'|'legacy', evidence: string[], runtime: {classic, module}, present: 'reveal'|'legacy' }
export function inspect(model) {
  if (isReveal(model)) {
    const runtime = runtimeEvidence(model);
    const evidence = ['.reveal > .slides > section'];
    if (runtime.classic) evidence.push('Reveal script');
    if (runtime.module) evidence.push('Reveal ES module');
    return { format: 'reveal', evidence, runtime, present: runtime.classic || runtime.module ? 'reveal' : 'legacy' };
  }
  return { format: 'legacy', evidence: [], runtime: { classic: false, module: false }, present: 'legacy' };
}
