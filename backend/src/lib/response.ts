import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
};

export function ok(body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

export function created(body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 201,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

export function noContent(): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 204, headers: CORS_HEADERS, body: "" };
}

export function error(
  statusCode: number,
  message: string,
  extra?: Record<string, unknown>,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify({ error: message, ...extra }),
  };
}

export function parseJson<T = unknown>(body: string | null | undefined): T {
  if (!body) throw new Error("Missing request body");
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}
