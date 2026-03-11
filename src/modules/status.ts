export interface RuntimeStatus {
  startedAt: string;
  uptimeSeconds: number;
  cacheSize: number;
  logSize: number;
  cookieCount: number;
  userCount: number;
  fastTransferSuccessCount: number;
}

export function getRuntimeStatus(params: {
  startedAt: number;
  cacheSize: number;
  logSize: number;
  cookieCount: number;
  userCount: number;
  fastTransferSuccessCount: number;
}): RuntimeStatus {
  const now = Date.now();
  return {
    startedAt: new Date(params.startedAt).toISOString(),
    uptimeSeconds: Math.floor((now - params.startedAt) / 1000),
    cacheSize: params.cacheSize,
    logSize: params.logSize,
    cookieCount: params.cookieCount,
    userCount: params.userCount,
    fastTransferSuccessCount: params.fastTransferSuccessCount
  };
}
