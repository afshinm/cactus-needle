import manifest from '../../vendor/manifest.json' with { type: 'json' };

export const DEFAULT_MODEL = Object.freeze({
  name: 'needle3',
  revision: manifest.revision,
  size: manifest.model.size,
  sha256: manifest.model.sha256,
  url: `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${manifest.model.path}`,
});
export const MODEL_FILE = manifest.model.path;
export const WASM_ARTIFACT = Object.freeze(manifest.files['needle.wasm']);
