// 把中心保存的配置与凭据转换为 Webfox 内存配置与隔离 env。
// 凭据只经 credential-ref 注入，不读宿主用户的全局 webfox 配置或 process.env。

// Webfox 4.8 provider credential 名与环境变量（与上游 provider metadata 一致）。
const PROVIDER_CREDENTIALS = {
  brave: [
    { env: 'BRAVE_SEARCH_API_KEY', ref: 'braveSearch' },
    { env: 'BRAVE_ANSWERS_API_KEY', ref: 'braveAnswers' },
  ],
  cloudflare: [{ env: 'CLOUDFLARE_API_TOKEN', ref: 'cloudflareToken' }],
  exa: [{ env: 'EXA_API_KEY', ref: 'exa' }],
  firecrawl: [{ env: 'FIRECRAWL_API_KEY', ref: 'firecrawl' }],
  gemini: [{ env: 'GOOGLE_API_KEY', ref: 'gemini' }],
  linkup: [{ env: 'LINKUP_API_KEY', ref: 'linkup' }],
  ollama: [{ env: 'OLLAMA_API_KEY', ref: 'ollama' }],
  openai: [{ env: 'OPENAI_API_KEY', ref: 'openai' }],
  parallel: [{ env: 'PARALLEL_API_KEY', ref: 'parallel' }],
  perplexity: [{ env: 'PERPLEXITY_API_KEY', ref: 'perplexity' }],
  serpbase: [{ env: 'SERPBASE_API_KEY', ref: 'serpbase' }],
  serper: [{ env: 'SERPER_API_KEY', ref: 'serper' }],
  tavily: [{ env: 'TAVILY_API_KEY', ref: 'tavily' }],
  valyu: [{ env: 'VALYU_API_KEY', ref: 'valyu' }],
  youcom: [{ env: 'YDC_API_KEY', ref: 'youcom' }],
};

const CAPABILITIES = ['search', 'contents', 'answer', 'research'];

/** 每个已启用能力的 provider 选择；缺省或缺 provider 的能力不注册工具。 */
export function selectedCapabilities(config) {
  const selected = [];
  for (const capability of CAPABILITIES) {
    const entry = config.capabilities?.[capability];
    if (entry && typeof entry.provider === 'string' && entry.provider) {
      selected.push({ capability, provider: entry.provider, maxResults: entry.maxResults });
    }
  }
  return selected;
}

/** WebfoxConfig：能力默认 provider 与执行参数；凭据全走 env，不写配置值。 */
export function buildWebfoxConfig(config) {
  const defaults = {};
  for (const { capability, provider, maxResults } of selectedCapabilities(config)) {
    defaults[capability] = { provider, ...(capability === 'search' && maxResults !== undefined ? { maxResults } : {}) };
  }
  const providers = {};
  for (const [id, entry] of Object.entries(config.providers ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    providers[id] = {
      ...(typeof entry.baseUrl === 'string' && entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      ...(entry.options && typeof entry.options === 'object' ? { options: entry.options } : {}),
    };
  }
  const execution = {};
  if (config.timeoutMs !== undefined) execution.timeoutMs = config.timeoutMs;
  if (config.researchTimeoutMs !== undefined) execution.researchTimeoutMs = config.researchTimeoutMs;
  if (config.retries !== undefined) execution.retries = config.retries;
  if (config.concurrency !== undefined) execution.concurrency = config.concurrency;
  return { defaults, execution, providers };
}

/** 隔离 env：仅含 Webfox provider 变量与代理/路径基础变量。 */
export function buildWebfoxEnv(config, credentials) {
  const env = {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.HTTP_PROXY === undefined ? {} : { HTTP_PROXY: process.env.HTTP_PROXY }),
    ...(process.env.HTTPS_PROXY === undefined ? {} : { HTTPS_PROXY: process.env.HTTPS_PROXY }),
    ...(process.env.NO_PROXY === undefined ? {} : { NO_PROXY: process.env.NO_PROXY }),
    ...(process.env.no_proxy === undefined ? {} : { no_proxy: process.env.no_proxy }),
  };
  const refs = config.credentials ?? {};
  const resolve = (ref) => {
    if (ref === undefined) return undefined;
    const value = credentials?.[ref];
    if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)) {
      throw Object.assign(new Error(`Webfox credential reference ${ref} is unavailable or invalid.`), { code: 'INVALID_ARGUMENT' });
    }
    return value;
  };
  for (const list of Object.values(PROVIDER_CREDENTIALS)) {
    for (const { env: name, ref } of list) {
      const value = resolve(refs[ref]);
      if (value !== undefined) env[name] = value;
    }
  }
  const accountId = resolve(refs.cloudflareAccountId);
  if (accountId !== undefined) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return env;
}
