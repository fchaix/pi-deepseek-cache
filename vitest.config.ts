import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 扩展的 UI 文案默认按环境语言解析（非中文区域 -> 英文，见 index.ts resolveLanguage）。
    // 若让测试依赖运行环境的 LANG/LC_ALL，同一份代码在开发者本机与 CI 上会断言不同的字符串。
    // 这里固定为 zh，使断言与语言无关；语言选择逻辑本身由 "language selection" 用例覆盖。
    env: { PI_DEEPSEEK_CACHE_LANG: "zh" },
  },
});
