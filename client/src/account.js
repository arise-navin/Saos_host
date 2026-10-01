let accountId = '';
export function setAccountId(id) { accountId = id || ''; }
export function accountStorageKey(key) { return accountId ? `${key}:${accountId}` : key; }
