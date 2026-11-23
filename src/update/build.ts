/// <reference types="vite/client" />

export interface BuildInfo { version: string; id: string; builtAt: string }
declare const __NEXUS_BUILD_INFO__: BuildInfo;

/** The build actually running in this document, never the server's latest build. */
export const CURRENT_BUILD: BuildInfo = typeof __NEXUS_BUILD_INFO__ === 'undefined'
  ? { version: 'Entwicklung', id: 'dev', builtAt: '' }
  : Object.freeze(__NEXUS_BUILD_INFO__);

export function parseBuildInfo(value: unknown): BuildInfo {
  if (!value || typeof value !== 'object') throw new Error('Die Build-Information ist unvollständig.');
  const item = value as Record<string, unknown>;
  if (typeof item.version !== 'string' || !item.version || item.version.length > 80
    || typeof item.id !== 'string' || !/^[a-z\d][a-z\d._-]{0,99}$/i.test(item.id)
    || typeof item.builtAt !== 'string' || !Number.isFinite(Date.parse(item.builtAt))) {
    throw new Error('Die Build-Information ist ungültig.');
  }
  return { version: item.version, id: item.id, builtAt: item.builtAt };
}

export function isOlderBuild(candidate: BuildInfo, baseline: BuildInfo): boolean {
  return candidate.id !== baseline.id && Date.parse(candidate.builtAt) < Date.parse(baseline.builtAt);
}

export function installationIdentity(href: string, base = import.meta.env.BASE_URL) {
  const url = new URL(base, href);
  const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname);
  return { label: local ? 'Lokale Installation' : 'Web-Installation', address: `${url.origin}${url.pathname}` };
}
