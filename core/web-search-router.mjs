// SPDX-License-Identifier: Apache-2.0
import { CoreError } from './errors.mjs';
import { createWebTools } from './web-tools.mjs';
import { createParallelSearch } from './parallel-search.mjs';
import { createBailianSearch } from './bailian-search.mjs';

export const WEB_SEARCH_PROVIDERS = Object.freeze(['parallel', 'bailian', 'duckduckgo']);

/** Selection is human-controlled and lasts for this service session. No fallback can incur a new provider's charges. */
export function createWebSearchRouter({ pages = createWebTools(), parallel = createParallelSearch(), bailian = createBailianSearch(), provider = 'parallel' } = {}) {
  const validate = value => {
    if (!WEB_SEARCH_PROVIDERS.includes(value)) throw new CoreError('INVALID_SEARCH_PROVIDER', '请选择支持的搜索服务。');
    return value;
  };
  let selected = validate(provider);
  return Object.freeze({
    getProvider: () => selected,
    setProvider: value => { selected = validate(value); },
    read: (input, options) => pages.read(input, options),
    search(input, options) {
      const service = selected;
      if (service === 'parallel') return parallel.search(input, options);
      if (service === 'bailian') return bailian.search(input, options);
      return pages.search(input, options).then(result => ({ ...result, provider: 'duckduckgo' }));
    },
  });
}
