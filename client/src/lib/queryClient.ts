import { QueryClient, type QueryFunction } from "@tanstack/react-query";

export class ApiRequestError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function throwIfNotOk(res: Response) {
  if (res.ok) return;
  let code = "server_error";
  let message = res.statusText;
  try {
    const body = await res.json();
    code = body.code ?? code;
    message = body.message ?? message;
  } catch { /* 本文なし */ }
  throw new ApiRequestError(res.status, code, message);
}

export async function apiRequest<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  await throwIfNotOk(res);
  const data: T = await res.json();
  // 書き込みのあとは「今できること」を読み直す（何を登録・設定したかで変わる）
  if (method !== "GET") void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/owner/capabilities") });
  return data;
}

const defaultQueryFn: QueryFunction = async ({ queryKey }) => {
  const res = await fetch(queryKey.join("/"), { credentials: "include" });
  await throwIfNotOk(res);
  return res.json();
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { queryFn: defaultQueryFn, refetchOnWindowFocus: false, staleTime: 30_000, retry: false },
    mutations: { retry: false },
  },
});
