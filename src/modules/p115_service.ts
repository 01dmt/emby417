import { LinkCache } from "./cache.js";
import { AppConfig, PlaybackStrategy } from "./config.js";
import { P115Client } from "./p115client.js";
import { resolveDirectLink } from "./proxy.js";

export async function resolveSourceDirectLink(params: {
  config: AppConfig;
  cache: LinkCache;
  client: P115Client;
  sourceText: string;
  sourceCookie: string;
  requestHeaders: Record<string, string | undefined>;
  requestUserAgent: string;
  requestUserId?: string;
  requestMediaSourceId?: string;
  pathPrefixRules: string;
  forceStrategy?: PlaybackStrategy;
}) {
  return resolveDirectLink({
    options: {
      strmContent: params.sourceText,
      forceStrategy: params.forceStrategy,
      requestUserAgent: params.requestUserAgent,
      requestUserId: params.requestUserId,
      requestMediaSourceId: params.requestMediaSourceId,
      requestCookie: params.sourceCookie,
      requestHeaders: params.requestHeaders,
      pathPrefixRules: params.pathPrefixRules
    },
    config: params.config,
    cache: params.cache,
    client: params.client
  });
}

export async function resolvePickcodeDirectLink(params: {
  client: P115Client;
  pickcode: string;
  requestUserAgent: string;
  sourceCookie: string;
  pathPrefixRules: string;
}) {
  return params.client.getDirectLink(
    params.pickcode,
    params.requestUserAgent,
    params.pathPrefixRules,
    params.sourceCookie
  );
}
