/**
 * Credential check for the browser-facing /basemap/config.json (BASEMAP.md
 * 4.5). Used by the /basemap proxy tests and by scripts/check-key-exposure.mjs
 * against a running server. Reports only paths, never values.
 */

const CREDENTIAL_KEY =
  /(api[-_]?key|apikey|^key$|token|secret|passw|auth|credential|signature|cookie|bearer)/i;
const CREDENTIAL_VALUE = [
  /AIza[0-9A-Za-z_-]{30,}/,
  /MLY\|\d{8,}\|[0-9a-f]{20,}/i,
  /eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/, // JWT
  /[?&](key|token|access_token|sig|signature)=/i,
  /^Bearer\s/i,
];

/**
 * @param {unknown} config - parsed JSON
 * @returns {{credentialFields: string[], credentialValues: string[], externalUrls: string[]}}
 */
export function basemapConfigFindings(config) {
  const findings = {
    credentialFields: [],
    credentialValues: [],
    externalUrls: [],
  };
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        if (CREDENTIAL_KEY.test(key)) findings.credentialFields.push(childPath);
        visit(child, childPath);
      }
      return;
    }
    if (typeof value !== 'string') return;
    if (CREDENTIAL_VALUE.some((re) => re.test(value)))
      findings.credentialValues.push(path);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('//'))
      findings.externalUrls.push(path);
  };
  visit(config, '');
  return findings;
}

/** Number of findings that must fail a key-exposure check. */
export function basemapConfigLeakCount(config) {
  const f = basemapConfigFindings(config);
  return (
    f.credentialFields.length +
    f.credentialValues.length +
    f.externalUrls.length
  );
}
