export interface ApiError {
  error?: {
    code?: string;
    message?: string;
    reason?: string;
    type?: string;
    reasons?: string[];
  };
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly reason?: string;
  readonly type?: string;
  readonly reasons?: string[];

  constructor(message: string, input: {
    status: number;
    code?: string;
    reason?: string;
    type?: string;
    reasons?: string[];
  }) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = input.status;
    this.code = input.code;
    this.reason = input.reason;
    this.type = input.type;
    this.reasons = input.reasons;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const hasBody = init?.body !== undefined && init?.body !== null;
  if (hasBody && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, {
    credentials: 'include',
    headers,
    ...init,
  });

  if (!response.ok) {
    let payload: ApiError | undefined;
    try {
      payload = (await response.json()) as ApiError;
    } catch {
      payload = undefined;
    }
    const message =
      payload && typeof payload.error === 'string'
        ? payload.error
        : payload?.error?.message ?? `Request failed with ${response.status}`;
    throw new ApiRequestError(message, {
      status: response.status,
      code: typeof payload?.error === 'object' ? payload.error.code : undefined,
      reason: typeof payload?.error === 'object' ? payload.error.reason : undefined,
      type: typeof payload?.error === 'object' ? payload.error.type : undefined,
      reasons: typeof payload?.error === 'object' ? payload.error.reasons : undefined,
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PUT',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PATCH',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}

export async function uploadAttachment(file: File, channelId?: string) {
  const form = new FormData();
  form.append('file', file, file.name);
  const params = channelId ? `?${new URLSearchParams({ channelId }).toString()}` : '';

  const response = await fetch(`/api/v1/media/attachments${params}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiError | null;
    throw new Error(payload?.error?.message ?? `Upload failed with ${response.status}`);
  }

  return response.json() as Promise<{
    id: string;
    fileName: string;
    mimeType: string;
    byteSize: number;
    path: string;
  }>;
}
