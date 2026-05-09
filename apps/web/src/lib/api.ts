export interface ApiError {
  error?: {
    code?: string;
    message?: string;
    reasons?: string[];
  };
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
    throw new Error(message);
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

export async function uploadAttachment(file: File) {
  const form = new FormData();
  form.append('file', file, file.name);

  const response = await fetch('/api/v1/media/attachments', {
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
