export type ModelCatalogErrorCode =
  | 'model_catalog_invalid_input'
  | 'model_catalog_unauthorized'
  | 'model_catalog_unavailable'
  | 'model_catalog_unsupported'
  | 'model_catalog_invalid_response'
  | 'model_catalog_empty';

export class ModelCatalogError extends Error {
  readonly code: ModelCatalogErrorCode;
  constructor(code: ModelCatalogErrorCode) { super(code); this.code = code; }
}

function modelsUrl(baseUrl: unknown): URL {
  if (typeof baseUrl !== 'string' || !baseUrl || baseUrl !== baseUrl.trim()
    || baseUrl.includes('?') || baseUrl.includes('#')) throw new ModelCatalogError('model_catalog_invalid_input');
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new ModelCatalogError('model_catalog_invalid_input'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname)
    throw new ModelCatalogError('model_catalog_invalid_input');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const basePath = pathname.replace(/\/(?:chat\/completions|embeddings|rerank|rerankers)$/, '') || '/';
  url.pathname = `${basePath === '/' ? '' : basePath}/models`;
  return url;
}

export async function listModels(baseUrl: unknown, key: unknown): Promise<{models: string[]}> {
  const url = modelsUrl(baseUrl);
  if (key !== undefined && (typeof key !== 'string' || /[\r\n]/.test(key)))
    throw new ModelCatalogError('model_catalog_invalid_input');
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: key ? {Authorization: `Bearer ${key}`} : {},
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
  } catch { throw new ModelCatalogError('model_catalog_unavailable'); }
  if (response.status === 401 || response.status === 403) throw new ModelCatalogError('model_catalog_unauthorized');
  if ([404, 405, 501].includes(response.status)) throw new ModelCatalogError('model_catalog_unsupported');
  if (!response.ok) throw new ModelCatalogError('model_catalog_unavailable');
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new ModelCatalogError('model_catalog_invalid_response'); }
  if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data))
    throw new ModelCatalogError('model_catalog_invalid_response');
  const models: string[] = [];
  const seen = new Set<string>();
  for (const item of payload.data) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim())
      throw new ModelCatalogError('model_catalog_invalid_response');
    if (!seen.has(item.id)) { models.push(item.id); seen.add(item.id); }
  }
  if (models.length === 0) throw new ModelCatalogError('model_catalog_empty');
  return {models};
}
