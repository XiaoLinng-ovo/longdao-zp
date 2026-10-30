export interface AppConfig {
  appName: string;
  appVersion: string;
  host: string;
  port: number;
  nodeEnv: string;
  requestIdHeader: string;
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 3100;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  return port;
}

/**
 * Reads process configuration once at the HTTP boundary.
 * Passing an env object makes the loader deterministic in tests and workers.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    appName: env.APP_NAME?.trim() || 'smartrecruit-pro-api',
    appVersion: env.APP_VERSION?.trim() || '0.1.0',
    host: env.HOST?.trim() || '127.0.0.1',
    port: readPort(env.PORT),
    nodeEnv: env.NODE_ENV?.trim() || 'development',
    requestIdHeader: 'x-request-id'
  };
}
