/** Passive browser evidence shared by compiler and recorder; no site-specific plans. */
export type CapturedExchange = {
  url: string;
  method: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseStatus: number;
  responseHeaders?: Record<string, string>;
  responseBody: string;
};
