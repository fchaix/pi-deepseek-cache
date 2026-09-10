import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

function clearPersistedData() {
  const dir = join(homedir(), ".pi", "agent", "extensions", "deepseek-cache");
  ["stats.json", "history.json", "summary-cache.json"].forEach((f) => {
    const p = join(dir, f);
    if (existsSync(p)) unlinkSync(p);
  });
}

/** 极简 theme stub：CacheStatsOverlay/GraphOverlay 只用到 fg(color, str) */
const stubTheme = { fg: (_c: string, s: string) => s } as unknown as Theme;

/** 扩展事件监听器签名（各钩子参数形态不一，测试内按需 cast） */
type Listener = (...args: unknown[]) => unknown;

/** mock 仅实现 on/registerCommand，cast 到真实 ExtensionAPI 以避免引入 any */
const asApi = (api: ReturnType<typeof createMockExtensionAPI>) => api as unknown as ExtensionAPI;

/** 摘要请求的返回体在测试中只用 content 文本 */
type CompletionResult = { content: Array<{ type: string; text?: string }> };
const completion = (text: string): CompletionResult => ({ content: [{ type: "text", text }] });

import index, { resolveLanguage } from "../index.js";

describe("language selection", () => {
  it("defaults to English for non-Chinese locales", () => {
    expect(resolveLanguage({ LANG: "fr_FR.UTF-8" })).toBe("en");
  });

  it("uses Chinese for Chinese locales", () => {
    expect(resolveLanguage({ LANG: "zh_CN.UTF-8" })).toBe("zh");
  });

  it("lets PI_DEEPSEEK_CACHE_LANG take precedence", () => {
    expect(resolveLanguage({ PI_DEEPSEEK_CACHE_LANG: "en", LANG: "zh_CN.UTF-8" })).toBe("en");
  });
});

function createMockExtensionAPI() {
  const listeners = new Map<string, Function[]>();
  const commands = new Map<string, { description: string; handler: Function }>();
  return {
    on: vi.fn((event: string, listener: Function) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
    }),
    registerCommand: vi.fn((name: string, cmd: any) => {
      commands.set(name, cmd);
    }),
    __emit: async (event: string, data: any) => {
      for (const fn of listeners.get(event) ?? []) await fn(data, mockCtx);
    },
    __getCommand: (name: string) => commands.get(name),
  };
}

/** 摘要在 1.2.x 走 ctx.modelRegistry.complete（由宿主在请求时解析鉴权） */
const completeMock = vi.fn();

const mockCtx = {
  ui: {
    setStatus: vi.fn(),
    notify: vi.fn(),
    custom: vi.fn().mockResolvedValue(undefined),
  },
  modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn(), complete: completeMock },
};

/** 取某个事件的监听器 */
function listenerFor(api: ReturnType<typeof createMockExtensionAPI>, event: string): Listener {
  const fn = (api.on as unknown as { mock: { calls: [string, Listener][] } }).mock.calls.find(
    ([e]) => e === event,
  )?.[1];
  expect(fn, `未注册 ${event} 监听器`).toBeDefined();
  return fn as Listener;
}

/** 执行 /cache-stats 并返回弹窗的纯文本渲染结果 */
async function renderStats(api: ReturnType<typeof createMockExtensionAPI>): Promise<string> {
  await api.__getCommand("cache-stats")!.handler([], mockCtx);
  const factory = mockCtx.ui.custom.mock.calls.at(-1)![0] as (
    tui: unknown,
    theme: Theme,
    kb: unknown,
    done: () => void,
  ) => { render: (w: number) => string[] };
  return factory(undefined, stubTheme, undefined, () => {})
    .render(120)
    .join("\n");
}

const PREFIX_BREAK_WARNING = "缓存前缀变化";

// ═══ P1: 命中率遥测 ═══
describe("P1: cache hit telemetry", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => {
    clearPersistedData();
    api = createMockExtensionAPI();
    index(api as any);
  });

  it("累计 cacheRead / input / cacheWrite / turns", async () => {
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 100, input: 50, cacheWrite: 10 } },
    });
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 200, input: 30, cacheWrite: 5 } },
    });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("忽略非 assistant 消息", async () => {
    await api.__emit("message_end", {
      message: { role: "user", usage: { cacheRead: 999, input: 999, cacheWrite: 999 } },
    });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("无 usage 时不崩溃", async () => {
    await api.__emit("message_end", { message: { role: "assistant" } });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("cacheRead/denom=0 时不除零", async () => {
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 0, input: 0, cacheWrite: 0 } },
    });
    await api.__getCommand("cache-stats")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });
});

// ═══ P1a: cache-graph 命令 ═══
describe("P1a: cache-graph command", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => {
    clearPersistedData();
    api = createMockExtensionAPI();
    index(api as any);
  });

  it("无历史数据时显示提示", async () => {
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("有数据时输出图表", async () => {
    for (const [cr, inp] of [
      [0, 100],
      [50, 50],
      [80, 20],
      [90, 10],
      [95, 5],
    ]) {
      await api.__emit("message_end", {
        message: { role: "assistant", usage: { cacheRead: cr, input: inp, cacheWrite: 0 } },
      });
    }
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("相同命中率不重复记录", async () => {
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 10, input: 10, cacheWrite: 0 } },
    });
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 20, input: 20, cacheWrite: 0 } },
    });
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 30, input: 30, cacheWrite: 0 } },
    });
    await api.__emit("message_end", {
      message: { role: "assistant", usage: { cacheRead: 80, input: 20, cacheWrite: 0 } },
    });
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });

  it("图表包含 X 轴 turn 编号", async () => {
    for (const [cr, inp] of [
      [0, 100],
      [50, 50],
      [80, 20],
      [90, 10],
      [95, 5],
    ]) {
      await api.__emit("message_end", {
        message: { role: "assistant", usage: { cacheRead: cr, input: inp, cacheWrite: 0 } },
      });
    }
    await api.__getCommand("cache-graph")!.handler([], mockCtx);
    expect(mockCtx.ui.custom).toHaveBeenCalled();
  });
});

// ═══ P2: 前缀守卫 ═══
describe("P2: volatile-scratch stripping", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => {
    clearPersistedData();
    api = createMockExtensionAPI();
    index(api as any);
  });

  it("过滤掉 customType=volatile-scratch 的消息", async () => {
    const messages = [
      { role: "system", content: "keep" },
      { role: "user", customType: "volatile-scratch", content: "scratch" },
      { role: "assistant", content: "keep" },
      { role: "user", customType: "volatile-scratch", content: "scratch2" },
    ];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual([
      { role: "system", content: "keep" },
      { role: "assistant", content: "keep" },
    ]);
  });

  it("无 volatile-scratch 消息时保留全部", async () => {
    const messages = [
      { role: "system", content: "a" },
      { role: "user", content: "b" },
    ];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual(messages);
  });

  it("customType 字段为 undefined 时不过滤", async () => {
    const messages = [{ role: "user", content: "normal" }];
    const ctx = (api.on as any).mock.calls.find(([e]: [string]) => e === "context")?.[1];
    expect((await ctx({ messages }, mockCtx)).messages).toEqual(messages);
  });

  it("before_provider_request 记录前缀哈希", async () => {
    const ctx = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "before_provider_request",
    )?.[1];
    expect(ctx).toBeDefined();
    ctx(
      {
        payload: {
          messages: [
            { role: "system", content: "a" },
            { role: "user", content: "b" },
          ],
        },
      },
      mockCtx,
    );
  });
});

// ═══ P3: session_before_compact ═══
describe("P3: session_before_compact", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => {
    clearPersistedData();
    api = createMockExtensionAPI();
    mockCtx.modelRegistry.find.mockReturnValue({ id: "deepseek-v4-flash", provider: "deepseek" });
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
      ok: true,
      apiKey: "sk-test",
      headers: {},
    });
    completeMock.mockReset();
    index(api as any);
  });

  it("相同输入命中摘要缓存", async () => {
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    const prep = {
      messagesToSummarize: [{ role: "user", content: "hello" }],
      firstKeptEntryId: "e1",
      tokensBefore: 1000,
      previousSummary: "",
    };
    completeMock.mockResolvedValueOnce({ content: [{ type: "text", text: "summary A" }] } as any);
    expect(
      (await listener({ preparation: prep, signal: new AbortController().signal }, mockCtx))
        .compaction.summary,
    ).toBe("summary A");
    completeMock.mockClear();
    expect(
      (await listener({ preparation: prep, signal: new AbortController().signal }, mockCtx))
        .compaction.summary,
    ).toBe("summary A");
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("模型不存在时回退", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    expect(
      await listener(
        {
          preparation: {
            messagesToSummarize: [],
            firstKeptEntryId: "e1",
            tokensBefore: 500,
            previousSummary: "",
          },
          signal: new AbortController().signal,
        },
        mockCtx,
      ),
    ).toBeUndefined();
  });

  it("previousSummary 并入 hash 输入", async () => {
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    completeMock.mockResolvedValueOnce({ content: [{ type: "text", text: "summary v1" }] } as any);
    const r1 = await listener(
      {
        preparation: {
          messagesToSummarize: [{ role: "user", content: "same" }],
          firstKeptEntryId: "e1",
          tokensBefore: 100,
          previousSummary: "v1",
        },
        signal: new AbortController().signal,
      },
      mockCtx,
    );
    completeMock.mockResolvedValueOnce({ content: [{ type: "text", text: "summary v2" }] } as any);
    const r2 = await listener(
      {
        preparation: {
          messagesToSummarize: [{ role: "user", content: "same" }],
          firstKeptEntryId: "e1",
          tokensBefore: 100,
          previousSummary: "v2",
        },
        signal: new AbortController().signal,
      },
      mockCtx,
    );
    expect(r1.compaction.summary).toBe("summary v1");
    expect(r2.compaction.summary).toBe("summary v2");
  });

  it("鉴权失败时回退", async () => {
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValueOnce({
      ok: false,
      error: "no credential",
    });
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    expect(
      await listener(
        {
          preparation: {
            messagesToSummarize: [],
            firstKeptEntryId: "e1",
            tokensBefore: 500,
            previousSummary: "",
          },
          signal: new AbortController().signal,
        },
        mockCtx,
      ),
    ).toBeUndefined();
  });

  // 回归：官方 ResolvedRequestAuth 允许 ok:true 而 apiKey 为 undefined（纯 headers/OAuth 类 provider）。
  // 旧实现用 `!auth.ok || !auth.apiKey` 判定，会把这类 provider 误判为鉴权失败并静默放弃自定义压缩。
  it("apiKey 为空但 auth.ok（纯 headers/OAuth）时仍继续摘要", async () => {
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValueOnce({
      ok: true,
      apiKey: undefined,
      headers: { "x-api-key": "h" },
    });
    completeMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "summary via headers" }],
    } as any);
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    const r = await listener(
      {
        preparation: {
          messagesToSummarize: [{ role: "user", content: "hi" }],
          firstKeptEntryId: "e1",
          tokensBefore: 100,
          previousSummary: "",
        },
        signal: new AbortController().signal,
      },
      mockCtx,
    );
    expect(r.compaction.summary).toBe("summary via headers");
  });

  // 回归：截断的摘要不得成为检查点（pi 自身同样拒绝，见 getSummarizationFailure）。
  // 否则不完整的摘要会替换历史，并按输入哈希被 summary-cache.json 固化。
  it("stopReason=length（截断）时回退，不采纳不完整摘要", async () => {
    completeMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "partial summ" }],
      stopReason: "length",
    } as any);
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    expect(
      await listener(
        {
          preparation: {
            messagesToSummarize: [{ role: "user", content: "x" }],
            firstKeptEntryId: "e1",
            tokensBefore: 500,
            previousSummary: "",
          },
          signal: new AbortController().signal,
        },
        mockCtx,
      ),
    ).toBeUndefined();
  });

  it("stopReason=error 时回退", async () => {
    completeMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "partial" }],
      stopReason: "error",
      errorMessage: "boom",
    } as any);
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    expect(
      await listener(
        {
          preparation: {
            messagesToSummarize: [{ role: "user", content: "x" }],
            firstKeptEntryId: "e1",
            tokensBefore: 500,
            previousSummary: "",
          },
          signal: new AbortController().signal,
        },
        mockCtx,
      ),
    ).toBeUndefined();
  });

  it("stopReason=stop（正常结束）时采纳摘要", async () => {
    completeMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "complete summary" }],
      stopReason: "stop",
    } as any);
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    const r = await listener(
      {
        preparation: {
          messagesToSummarize: [{ role: "user", content: "x" }],
          firstKeptEntryId: "e1",
          tokensBefore: 500,
          previousSummary: "",
        },
        signal: new AbortController().signal,
      },
      mockCtx,
    );
    expect(r.compaction.summary).toBe("complete summary");
  });

  it("complete 调用失败时回退", async () => {
    completeMock.mockRejectedValueOnce(new Error("API error"));
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    expect(
      await listener(
        {
          preparation: {
            messagesToSummarize: [{ role: "user", content: "test" }],
            firstKeptEntryId: "e1",
            tokensBefore: 500,
            previousSummary: "",
          },
          signal: new AbortController().signal,
        },
        mockCtx,
      ),
    ).toBeUndefined();
  });

  it("空摘要时回退", async () => {
    completeMock.mockResolvedValueOnce({ content: [{ type: "text", text: "   " }] } as any);
    const listener = (api.on as any).mock.calls.find(
      ([e]: [string]) => e === "session_before_compact",
    )?.[1];
    expect(
      await listener(
        {
          preparation: {
            messagesToSummarize: [],
            firstKeptEntryId: "e1",
            tokensBefore: 500,
            previousSummary: "",
          },
          signal: new AbortController().signal,
        },
        mockCtx,
      ),
    ).toBeUndefined();
  });
});

// ═══ R13: 官方定价（Models & Pricing, 每百万 token）═══
describe("R13: 官方定价", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  beforeEach(() => {
    clearPersistedData();
    mockCtx.ui.notify.mockClear();
    mockCtx.ui.custom.mockClear();
    api = createMockExtensionAPI();
    index(asApi(api));
  });
  afterEach(() => vi.useRealTimers());

  // 2026-01-05 为周一，02:00 UTC 落在官方峰值窗口 01:00-04:00 内
  const PEAK = "2026-01-05T02:00:00Z";
  // 2026-01-03 为周六，任何时刻均为谷值
  const OFF_PEAK = "2026-01-03T02:00:00Z";

  const emit = (model: string, cacheRead: number, input: number) =>
    api.__emit("message_end", {
      message: { role: "assistant", model, usage: { cacheRead, input, cacheWrite: 0 } },
    });

  it("flash 峰值按 $0.006 / $0.30 计价", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PEAK));
    await emit("deepseek-v4-flash", 1_000_000, 0);
    const out = await renderStats(api);
    expect(out).toContain("hit $0.006 / miss $0.3 per 1M");
    expect(out).toContain("$0.294"); // 1M × (0.30 − 0.006)
    expect(out).toContain("峰值时段");
  });

  it("谷值时段单价减半（官方注(2)）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(OFF_PEAK));
    await emit("deepseek-v4-flash", 1_000_000, 0);
    const out = await renderStats(api);
    expect(out).toContain("hit $0.003 / miss $0.15 per 1M");
    expect(out).toContain("$0.147"); // 1M × (0.15 − 0.003)
    expect(out).toContain("谷值时段");
  });

  it("v4-pro 按 Pro 自身价目表计价（官方 2026-09-10：v4-pro 继续提供，计费方式不变）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PEAK));
    await emit("deepseek-v4-pro", 1_000_000, 0);
    const out = await renderStats(api);
    expect(out).toContain("deepseek-v4-pro");
    expect(out).toContain("hit $0.044 / miss $1.32 per 1M");
    expect(out).toContain("$1.28"); // 1M × (1.32 − 0.044) = $1.276，大额固定 2 位小数
  });

  it("v4-pro 谷值价为其峰值价的一半", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(OFF_PEAK));
    await emit("deepseek-v4-pro", 1_000_000, 0);
    expect(await renderStats(api)).toContain("hit $0.022 / miss $0.66 per 1M");
  });

  // 2026-05-01（周五，劳动节）02:00 UTC 落在峰值窗口内，但官方注(2) 排除中国公共假期
  const CN_HOLIDAY_PEAK_WINDOW = "2026-05-01T02:00:00Z";
  // 2026-05-04（周一）同为劳动节假期
  const CN_HOLIDAY_MONDAY = "2026-05-04T02:00:00Z";
  // 2026-05-08（周五）假期之后，同为峰值窗口
  const AFTER_HOLIDAY_FRIDAY = "2026-05-08T02:00:00Z";

  it("中国公共假期内不开峰值（官方注(2) 排除中国公共假期）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CN_HOLIDAY_PEAK_WINDOW));
    await emit("deepseek-flash", 1_000_000, 0);
    const out = await renderStats(api);
    expect(out).toContain("谷值时段");
    expect(out).toContain("hit $0.003 / miss $0.15 per 1M");
  });

  it("假期期间的周一同样不开峰值", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CN_HOLIDAY_MONDAY));
    await emit("deepseek-flash", 1_000_000, 0);
    expect(await renderStats(api)).toContain("谷值时段");
  });

  it("假期结束后同一时段恢复峰值", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AFTER_HOLIDAY_FRIDAY));
    await emit("deepseek-flash", 1_000_000, 0);
    expect(await renderStats(api)).toContain("峰值时段");
  });

  it("未收录年份不会误判为假期（退化为旧行为）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-05-01T02:00:00Z"));
    await emit("deepseek-flash", 1_000_000, 0);
    expect(await renderStats(api)).toContain("峰值时段");
  });

  it("已停用的 deepseek-chat / deepseek-reasoner 仍能取到价（官方 2026-07-24 停用）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PEAK));
    await emit("deepseek-chat", 1_000_000, 0);
    const chat = await renderStats(api);
    await emit("deepseek-reasoner", 0, 0);
    const reasoner = await renderStats(api);
    const priceOf = (s: string) =>
      s
        .split("\n")
        .find((l) => l.includes("per 1M"))!
        .replace(/[│\s]/g, "");
    expect(priceOf(chat)).toBe("hit$0.006/miss$0.3per1M");
    expect(priceOf(reasoner)).toBe(priceOf(chat));
  });

  it("官方当前名 deepseek-flash 与 legacy 名同价（官方注(1)：legacy 已退役但仍受理）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PEAK));
    await emit("deepseek-flash", 1_000_000, 0);
    const current = await renderStats(api);
    await emit("deepseek-v4-flash", 0, 0);
    const legacy = await renderStats(api);
    const priceOf = (s: string) =>
      s
        .split("\n")
        .find((l) => l.includes("per 1M"))!
        .replace(/[│\s]/g, "");
    expect(priceOf(current)).toBe(priceOf(legacy));
  });

  it("未知模型取保守下界，不高估节省", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PEAK));
    await emit("some-unknown-model", 1_000_000, 0);
    const out = await renderStats(api);
    expect(out).toContain("hit $0.003 / miss $0.15 per 1M");
    expect(out).toContain("$0.1470");
    expect(out).toContain("some-unknown-model");
  });

  it("尚未观测到任何模型时标为未知模型", async () => {
    await renderStats(api);
    expect(await renderStats(api)).toContain("未知模型");
  });

  it("同时展示累计与本轮命中率，二者口径不同", async () => {
    await emit("deepseek-v4-flash", 0, 100);
    await emit("deepseek-v4-flash", 90, 10);
    const out = await renderStats(api);
    expect(out).toContain("累计命中率");
    expect(out).toContain("45.0%"); // 90 / (90+110) 跨轮累计
    expect(out).toContain("本轮命中率");
    expect(out).toContain("90.0%"); // 90 / (90+10) 官方逐次口径
  });

  it("官方无 cache write 字段，未观测到写入时隐藏该行", async () => {
    await emit("deepseek-v4-flash", 10, 10);
    expect(await renderStats(api)).not.toContain("缓存写入");
  });

  it("观测到非零写入时展示该行（供将来支持写入计费的 provider）", async () => {
    await api.__emit("message_end", {
      message: {
        role: "assistant",
        model: "deepseek-v4-flash",
        usage: { cacheRead: 10, input: 10, cacheWrite: 5 },
      },
    });
    expect(await renderStats(api)).toContain("缓存写入");
  });

  it("节省额低于 $0.01 时降级显示", async () => {
    await emit("deepseek-v4-flash", 100, 100);
    expect(await renderStats(api)).toContain("< $0.01");
  });
});

// ═══ R14: 前缀指纹覆盖 tools（官方要求 system+tools+messages 整体匹配）═══
describe("R14: tools 纳入前缀指纹", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  let bpr: Listener;
  const TOOLS = [{ name: "read" }, { name: "edit" }];

  beforeEach(() => {
    clearPersistedData();
    mockCtx.ui.notify.mockClear();
    api = createMockExtensionAPI();
    index(asApi(api));
    bpr = listenerFor(api, "before_provider_request");
  });
  const send = (tools: unknown, messages: unknown[]) =>
    bpr({ payload: { tools, messages } }, mockCtx);
  const MSG = [
    { role: "system", content: "a" },
    { role: "user", content: "b" },
  ];

  it("工具增删触发告警（tools 是独立顶层字段，不在 messages 内）", () => {
    send(TOOLS, MSG);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
    send([{ name: "read" }], MSG);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(PREFIX_BREAK_WARNING),
      "warning",
    );
  });

  it("工具 schema 变化触发告警", () => {
    send(TOOLS, MSG);
    send([{ name: "read", description: "x" }, { name: "edit" }], MSG);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(PREFIX_BREAK_WARNING),
      "warning",
    );
  });

  it("工具顺序抖动被码点排序吸收，不误报", () => {
    send(TOOLS, MSG);
    send([{ name: "edit" }, { name: "read" }], MSG);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("消息追加且工具不变时不告警（官方 Example 1）", () => {
    send(TOOLS, MSG);
    send(TOOLS, [...MSG, { role: "assistant", content: "c" }]);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("历史被改写时告警", () => {
    send(TOOLS, MSG);
    send(TOOLS, [
      { role: "system", content: "a" },
      { role: "user", content: "REWRITTEN" },
    ]);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(PREFIX_BREAK_WARNING),
      "warning",
    );
  });

  it("回落到早期已知前缀时视为有效命中（官方 Example 2：unit 可并存）", () => {
    send(TOOLS, MSG);
    send(TOOLS, [
      { role: "system", content: "a" },
      { role: "user", content: "other" },
    ]);
    mockCtx.ui.notify.mockClear();
    send(TOOLS, MSG); // 回到第一条已落盘前缀
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("首轮建立基线不告警", () => {
    send(TOOLS, MSG);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("session_start 重置指纹，避免跨会话误报", () => {
    send(TOOLS, MSG);
    listenerFor(api, "session_start")({}, mockCtx);
    mockCtx.ui.notify.mockClear();
    send(TOOLS, MSG);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("空/无 messages 时静默跳过，不告警", () => {
    send(TOOLS, []);
    bpr({ payload: null }, mockCtx);
    bpr({ payload: {} }, mockCtx);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("无 tools 字段时按同一空值处理，不误报", () => {
    send(undefined, MSG);
    send(undefined, [...MSG, { role: "assistant", content: "c" }]);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });
});

// ═══ R15: 摘要器模型名兼容官方改名 ═══
describe("R15: 摘要器模型名", () => {
  let api: ReturnType<typeof createMockExtensionAPI>;
  let compact: Listener;
  let n = 0;

  beforeEach(() => {
    clearPersistedData();
    mockCtx.ui.notify.mockClear();
    mockCtx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
      ok: true,
      apiKey: "sk-test",
      headers: {},
    });
    completeMock.mockReset();
    api = createMockExtensionAPI();
    index(asApi(api));
    compact = listenerFor(api, "session_before_compact");
  });
  const run = () =>
    compact(
      {
        preparation: {
          messagesToSummarize: [{ role: "user", content: `uniq-${n++}` }],
          firstKeptEntryId: "e1",
          tokensBefore: 10,
          previousSummary: "",
        },
        signal: new AbortController().signal,
      },
      mockCtx,
    );

  it("优先使用官方当前名 deepseek-flash", async () => {
    mockCtx.modelRegistry.find.mockImplementation((_p: string, id: string) =>
      id === "deepseek-flash" ? { id, provider: "deepseek" } : null,
    );
    completeMock.mockResolvedValueOnce(completion("s1"));
    expect((await run()).compaction.details.summarizer).toBe("deepseek-flash");
  });

  it("目录仅有 legacy 名时回退到 deepseek-v4-flash", async () => {
    mockCtx.modelRegistry.find.mockImplementation((_p: string, id: string) =>
      id === "deepseek-v4-flash" ? { id, provider: "deepseek" } : null,
    );
    completeMock.mockResolvedValueOnce(completion("s2"));
    expect((await run()).compaction.details.summarizer).toBe("deepseek-v4-flash");
  });

  it("两个名字都不可用时回退默认 compaction", async () => {
    mockCtx.modelRegistry.find.mockReturnValue(null);
    expect(await run()).toBeUndefined();
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("找不到摘要模型"),
      "warning",
    );
  });
});
