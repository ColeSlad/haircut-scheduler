import { openStore } from '../server/store.js';
import { runtimeConfig, securityHeaders } from '../server/config.js';
import { createWebHandler } from '../server/web.js';
let handler;
export default {
  async fetch(request) {
    try {
      if (!handler) {
        const config = runtimeConfig();
        handler = createWebHandler(openStore(), config);
      }
      return await handler(request);
    } catch (error) {
      console.error('api_configuration_unavailable', error.configurationKeys || []);
      return Response.json({ error: 'The service is temporarily unavailable. Please try again.' }, { status: 503, headers: { ...securityHeaders, 'Cache-Control': 'no-store' } });
    }
  },
};
