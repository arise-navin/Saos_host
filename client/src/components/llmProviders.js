/*
 * The model providers the studio can run on, as the UI describes them.
 *
 * Shared by Settings and the setup wizard, so the two can never disagree about
 * what a provider needs. The SERVER is still the authority: it refuses a turn
 * whose provider is missing something (agent/providers/index.js), and nothing
 * here widens that — this only lets the UI say what is missing before a save.
 *
 * `mark` is a plain letter for a vendor (never its logo); `icon` names a generic
 * glyph for the kinds of provider that are a place rather than a company.
 *
 * Each requirement is 'required' | 'optional' | 'none' ('fixed' for a base URL
 * the provider does not let you change).
 */

export const PROVIDERS = Object.freeze([
  {
    id: 'anthropic',
    label: 'Anthropic',
    option: 'Anthropic (Claude)',
    blurb: 'Claude models through the Anthropic API.',
    tag: 'API key',
    mark: 'A',
    key: 'required',
    baseUrl: 'fixed',
    model: 'optional',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    option: 'OpenAI',
    blurb: 'GPT models through the OpenAI API.',
    tag: 'API key',
    mark: 'O',
    key: 'required',
    baseUrl: 'optional',
    model: 'optional',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    option: 'Ollama (local)',
    blurb: 'Runs on this machine. No key, and nothing leaves it.',
    tag: 'Local',
    icon: 'laptop',
    key: 'none',
    baseUrl: 'optional',
    model: 'optional',
    keyUrl: 'https://ollama.com/download',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    option: 'OpenRouter',
    blurb: 'Hundreds of models behind one key.',
    tag: 'API key',
    icon: 'route',
    key: 'required',
    baseUrl: 'optional',
    model: 'required',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'opencode',
    label: 'OpenCode-compatible',
    option: 'OpenCode-compatible (self-hosted)',
    blurb: 'Your own gateway speaking the OpenAI wire format.',
    tag: 'Self-hosted',
    icon: 'terminal',
    key: 'optional',
    baseUrl: 'required',
    model: 'required',
    keyUrl: null,
  },
]);

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];

/*
 * Placeholders for the fields. Where a provider has no default, the placeholder
 * says so rather than showing a value that would be a guess.
 */
export const PROVIDER_HINTS = {
  anthropic: { model: 'claude-sonnet-4-6', baseUrl: 'api.anthropic.com (fixed)', key: true },
  openai: { model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', key: true },
  ollama: { model: 'llama3.1 (tool-capable model required)', baseUrl: 'http://localhost:11434/v1', key: false },
  // No default model: OpenRouter fronts hundreds of vendor/model ids and one
  // has to be chosen. Settings and the wizard load them live rather than
  // shipping a list that goes stale.
  openrouter: { model: 'vendor/model — pick from the live list', baseUrl: 'https://openrouter.ai/api/v1', key: true },
  // Neither the model nor the base URL has a default, and the placeholders say
  // so rather than showing an address that would be a guess about the
  // operator's own network. "OpenCode-compatible" is a wire format (OpenAI
  // /chat/completions), not a hosted service, so the server refuses to send
  // anything until both are set. The key field is shown but OPTIONAL — a
  // self-hosted gateway may or may not want a bearer token, and the adapter
  // only sends an Authorization header when one is set; hiding the field would
  // make a token-protected gateway unusable.
  opencode: { model: 'required — whatever your gateway serves', baseUrl: 'required — e.g. http://localhost:4096/v1', key: true },
};

/**
 * What the chosen provider still needs before it can run.
 *
 * A saved key counts only for the provider it was saved under: there is one
 * key slot, so a key saved for one vendor must not satisfy another.
 *
 * @param {string} id               the provider being set up
 * @param {{apiKey?:string, baseUrl?:string, model?:string}} form  what is typed now
 * @param {{provider?:string, hasApiKey?:boolean}} [saved]          publicSettings().llm
 * @returns {{ ready: boolean, missing: string[] }}
 */
export function providerNeeds(id, form = {}, saved = {}) {
  const p = providerById(id);
  const missing = [];
  const keySaved = saved.provider === p.id && saved.hasApiKey;
  if (p.key === 'required' && !String(form.apiKey || '').trim() && !keySaved) missing.push('an API key');
  if (p.baseUrl === 'required' && !String(form.baseUrl || '').trim()) missing.push('a base URL');
  if (p.model === 'required' && !String(form.model || '').trim()) missing.push('a model');
  return { ready: missing.length === 0, missing };
}
