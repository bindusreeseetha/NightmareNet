import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

describe("API client advanced behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the exact exponential delay between API retry attempts", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(jsonResponse(503, { detail: "temporary" }))
      .mockResolvedValueOnce(jsonResponse(503, { detail: "temporary" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { status: "healthy", version: "0.2.0" }),
      );

    const { getHealth } = await import("@/lib/api");
    const request = getHealth();

    await vi.advanceTimersByTimeAsync(999);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1999);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toEqual({
      status: "healthy",
      version: "0.2.0",
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("honors Retry-After for a 429 response before retrying", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(429, { detail: "rate limited" }, { "Retry-After": "3" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { status: "healthy", version: "0.2.0" }),
      );

    const { getHealth } = await import("@/lib/api");
    const request = getHealth();

    await vi.advanceTimersByTimeAsync(2999);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toEqual({
      status: "healthy",
      version: "0.2.0",
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [400, "bad request"],
    [401, "unauthorized"],
  ])("maps non-retryable HTTP status %s to an error with its status", async (status, detail) => {
    mockFetch.mockResolvedValueOnce(jsonResponse(status, { detail }));

    const { getHealth } = await import("@/lib/api");

    try {
      await getHealth();
      expect.fail("getHealth should reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ message: detail, status });
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("preserves a server error after transient retries are exhausted", async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse(500, { detail: "server failure" })),
    );

    const { getHealth } = await import("@/lib/api");
    const request = getHealth();

    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);

    await expect(request).rejects.toMatchObject({
      message: "server failure",
      status: 500,
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("retries a network failure and returns the later successful response", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        jsonResponse(200, { status: "healthy", version: "0.2.0" }),
      );

    const { getHealth } = await import("@/lib/api");
    const request = getHealth();

    await vi.advanceTimersByTimeAsync(1000);

    await expect(request).resolves.toEqual({
      status: "healthy",
      version: "0.2.0",
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("adds the stored API key to authenticated API requests", async () => {
    localStorage.setItem("nightmarenet-api-key", "test-key");
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { status: "healthy", version: "0.2.0" }),
    );

    const { getHealth } = await import("@/lib/api");
    await getHealth();

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/health",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-API-Key": "test-key" }),
      }),
    );
  });

  it("forwards AbortController cancellation to the copilot fetch", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    mockFetch.mockRejectedValueOnce(abortError);

    const { askCopilot } = await import("@/lib/api");
    const iterator = askCopilot("test", "dashboard", undefined, controller.signal);
    const request = iterator.next();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/copilot/ask",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("builds the pipeline pagination query from offset and limit", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { runs: [], total: 0, offset: 20, limit: 10 }),
    );

    const { listPipelineRuns } = await import("@/lib/api");
    await listPipelineRuns(20, 10);

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/pipeline/runs?offset=20&limit=10",
      expect.objectContaining({ method: undefined }),
    );
  });

  it("falls back to an HTTP status message when an error body is not JSON", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("service unavailable", {
        status: 418,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const { getHealth } = await import("@/lib/api");

    await expect(getHealth()).rejects.toMatchObject({
      message: "API error 418",
      status: 418,
    });
  });
});
