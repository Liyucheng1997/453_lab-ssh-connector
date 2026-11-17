// 后端接口封装
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

export let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(method, url, body, { raw = false, headers = {} } = {}) {
  const opts = { method, headers: { 'x-yq': '1', ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    if (raw) {
      opts.body = body;
      opts.headers['Content-Type'] = 'text/plain; charset=utf-8';
    } else {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError('无法连接到云桥服务，请确认服务正在运行', 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && !url.startsWith('/api/auth/')) onUnauthorized();
  if (!res.ok) throw new ApiError(data?.error || `请求失败（${res.status}）`, res.status, data);
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body) => api('POST', url, body ?? {});
export const put = (url, body) => api('PUT', url, body ?? {});
export const del = (url) => api('DELETE', url);

/** 带进度的上传，返回 { promise, abort } */
export function uploadFile(url, file, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('PUT', url);
    xhr.setRequestHeader('x-yq', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data?.error || `上传失败（${xhr.status}）`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('网络错误，上传中断', 0));
    xhr.onabort = () => reject(new ApiError('已取消', 0));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
