import manifest from '../../vendor/manifest.json' with { type: 'json' };

export const DEFAULT_MODEL = Object.freeze({
  name: 'needle3',
  revision: manifest.revision,
  size: manifest.model.size,
  sha256: manifest.model.sha256,
  url: `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${manifest.model.path}`,
});
export const MODEL_FILE = manifest.model.path;
export const DEFAULT_SPEECH_MODEL = Object.freeze({
  name: 'whistle',
  revision: manifest.speechModel.revision,
  size: manifest.speechModel.size,
  sha256: manifest.speechModel.sha256,
  url: `https://huggingface.co/${manifest.speechModel.repository}/resolve/${manifest.speechModel.revision}/${manifest.speechModel.path}`,
});
export const SPEECH_MODEL_FILE = manifest.speechModel.path;
export const WASM_ARTIFACT = Object.freeze(manifest.files['needle.wasm']);
