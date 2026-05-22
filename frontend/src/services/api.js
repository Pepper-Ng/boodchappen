const DEFAULT_API_BASE_URL = '/api';

function normalizeBaseUrl(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().replace(/\/+$/, '');
}

function getRuntimeApiBaseUrl() {
  const runtimeConfig = globalThis.__BOODSCHAPPEN_CONFIG__;
  return normalizeBaseUrl(runtimeConfig?.apiBaseUrl);
}

function getBuildTimeApiBaseUrl() {
  return normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL);
}

export const API_BASE_URL = getRuntimeApiBaseUrl() || getBuildTimeApiBaseUrl() || DEFAULT_API_BASE_URL;

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

function extractMessage(data, fallback) {
  if (typeof data === 'string' && data.trim()) {
    return data;
  }

  if (data && typeof data === 'object') {
    if (typeof data.detail === 'string' && data.detail.trim()) {
      return data.detail;
    }

    if (Array.isArray(data.detail)) {
      const detail = data.detail
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }

          if (item && typeof item === 'object') {
            return item.msg || item.message || item.loc?.join('.') || '';
          }

          return '';
        })
        .filter(Boolean)
        .join(', ');

      if (detail) {
        return detail;
      }
    }

    if (typeof data.message === 'string' && data.message.trim()) {
      return data.message;
    }
  }

  return fallback;
}

async function parseResponse(response) {
  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}

export async function request(path, { token, method = 'GET', body, signal } = {}) {
  const headers = {
    Accept: 'application/json',
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await parseResponse(response);
  if (!response.ok) {
    throw new ApiError(response.status, extractMessage(data, response.statusText || 'Request failed'), data);
  }

  return data;
}

export function registerAccount(payload) {
  return request('/auth/register', {
    method: 'POST',
    body: payload,
  });
}

export function loginAccount(payload) {
  return request('/auth/login', {
    method: 'POST',
    body: payload,
  });
}

export function loadCurrentUser(token) {
  return request('/auth/me', { token });
}

export function listProducts(token) {
  return request('/products', { token });
}

export function importProduct(token, ahUrl) {
  return request('/products/import', {
    token,
    method: 'POST',
    body: { ah_url: ahUrl },
  });
}

export function listRecipes(token) {
  return request('/recipes', { token });
}

export function getRecipe(token, recipeId) {
  return request(`/recipes/${recipeId}`, { token });
}

export function deleteRecipe(token, recipeId) {
  return request(`/recipes/${recipeId}`, {
    token,
    method: 'DELETE',
  });
}

export function importRecipe(token, url) {
  return request('/recipes/import', {
    token,
    method: 'POST',
    body: { url },
  });
}

export function createRecipeImportJob(token, url) {
  return request('/recipes/import-jobs', {
    token,
    method: 'POST',
    body: { url },
  });
}

export function listImportJobs(token) {
  return request('/import-jobs', { token });
}

export function getImportJob(token, jobId) {
  return request(`/import-jobs/${jobId}`, { token });
}

export async function waitForRecipeImportJob(token, jobId, { onUpdate, intervalMs = 1600, maxAttempts = 75 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const job = await getImportJob(token, jobId);
    if (onUpdate) {
      onUpdate(job);
    }

    if (job.status === 'succeeded' || job.status === 'failed') {
      return job;
    }

    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, intervalMs);
    });
  }

  throw new ApiError(408, 'Timed out while waiting for the recipe import job to finish', null);
}

export function listWeekPlan(token) {
  return request('/weekplan', { token });
}

export function addWeekPlan(token, payload) {
  return request('/weekplan', {
    token,
    method: 'POST',
    body: payload,
  });
}

export function deleteWeekPlan(token, entryId) {
  return request(`/weekplan/${entryId}`, {
    token,
    method: 'DELETE',
  });
}

export function autoMatchRecipe(token, recipeId) {
  return request(`/recipes/${recipeId}/auto-match`, {
    token,
    method: 'POST',
  });
}

export function getRecipeProductSuggestions(token, recipeId) {
  return request(`/recipes/${recipeId}/product-suggestions`, { token });
}

export function matchRecipeIngredient(token, recipeId, ingredientId, payload) {
  return request(`/recipes/${recipeId}/ingredients/${ingredientId}/match`, {
    token,
    method: 'POST',
    body: payload,
  });
}

export function listGroceryLists(token) {
  return request('/grocery-lists', { token });
}

export function createGroceryList(token, name) {
  return request('/grocery-lists', {
    token,
    method: 'POST',
    body: { name },
  });
}

export function getGroceryList(token, listId) {
  return request(`/grocery-lists/${listId}`, { token });
}

export function buildGroceryList(token, listId, payload) {
  return request(`/grocery-lists/${listId}/build`, {
    token,
    method: 'POST',
    body: payload,
  });
}

export function addRecipeToGroceryList(token, listId, payload) {
  return request(`/grocery-lists/${listId}/recipes`, {
    token,
    method: 'POST',
    body: payload,
  });
}

export function updateGroceryListItem(token, listId, itemId, payload) {
  return request(`/grocery-lists/${listId}/items/${itemId}`, {
    token,
    method: 'PATCH',
    body: payload,
  });
}
