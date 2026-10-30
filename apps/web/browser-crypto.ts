type BrowserCrypto = Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>>;

/** HTTP IP previews expose getRandomValues, but randomUUID requires a secure context. */
export function installBrowserUUID(browser: BrowserCrypto) {
  if (typeof browser.randomUUID === 'function') return;
  browser.randomUUID = () => {
    const bytes = browser.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ReturnType<Crypto['randomUUID']>;
  };
}

installBrowserUUID(globalThis.crypto);
