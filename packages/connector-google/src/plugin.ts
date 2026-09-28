import type { Clock } from "@wappy_ai/core";
import type { OAuthConnectPlugin } from "@wappy_ai/productivity";
import { buildAuthUrl, exchangeCodeForTokens, type FetchImpl, type GoogleOAuthConfig } from "./oauth.js";
import type { GoogleTokenStore } from "./token-store.js";

export interface CreateGoogleOAuthPluginOptions {
  config: GoogleOAuthConfig;
  tokenStore: GoogleTokenStore;
  clock: Clock;
  fetchImpl?: FetchImpl;
}

/**
 * The real `@wappy_ai/productivity` `OAuthConnectPlugin` implementation for Google — this is the
 * ONLY place in this package that mentions `OAuthConnectPlugin` by name; `ui-server.ts` itself never
 * imports anything Google-specific (see its own doc comment). Wired into `createTaskUiServer({
 * oauthConnect: createGoogleOAuthPlugin({...}) })` by a generated project's `index.ts`.
 */
export function createGoogleOAuthPlugin(opts: CreateGoogleOAuthPluginOptions): OAuthConnectPlugin {
  return {
    label: "Google",
    callbackPath: "/google/callback",

    isAvailable() {
      return Boolean(opts.config.clientId && opts.config.clientSecret);
    },

    async isConnected() {
      return Boolean(await opts.tokenStore.get());
    },

    authUrl() {
      return buildAuthUrl(opts.config);
    },

    async handleCallback(url) {
      const code = url.searchParams.get("code");
      if (!code) return false;
      const tokens = await exchangeCodeForTokens(opts.config, code, opts.clock.now(), opts.fetchImpl);
      await opts.tokenStore.set(tokens);
      return true;
    },
  };
}
