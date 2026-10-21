# DSH 界面视觉规范（Design Tokens 与组件样式）

> 提取对象：本机安装的 DeepSeek Harness desktop（Electron）`app.asar`，版本以安装目录为准。
> 全部颜色、圆角、阴影、字号数值均从打包产物里抄录；凡是我自己换算或推断的，文中都标了「推断值」或「解析值」。

## 0. 怎么读这份规范

DSH 的样式是**三层 token 结构**，改主题只改中间层：

1. **static 层**（`--dsw-static-*`）：调色板原色，浅色/深色共用同一组数值，不随主题变。
2. **alias 层**（`--dsw-alias-*` / `--dsw-specific-*`）：语义变量，指向 static 层，**浅色定义在 `:root`，深色定义在 `body[data-ds-dark-theme]`**。
3. **组件层**：组件 CSS 只写 `var(--dsw-alias-*)`，不写死颜色。

另有少量**非 color 的全局 token**：`--dsw-radius-*`（形状）、`--dsw-shadow-lv1..3` + `--dsw-elevation-*`（阴影）、`--dsw-font-*`（排版复合简写）、`--dsw-focus-ring-*`（焦点）、`--ds-transition-*` / `--ds-ease-in-out`（动效）。

深色主题的开启方式是给 `<body>` 加属性 `data-ds-dark-theme`，没有 `prefers-color-scheme` 自适应——主题由应用状态显式控制。

### 实际读到的源文件

| 文件 | 作用 |
| --- | --- |
| `app.asar` → `dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js` | 主题运行时：注入下列 CSS 片段、管理深浅色切换 |
| `.../dsh-client-ui-theme/lib/styles/design-platform.css` | static 层 + alias 层全部变量（浅色 `body{}` / 深色 `body[data-ds-dark-theme]{}`） |
| `.../dsh-client-ui-theme/lib/styles/base.css` | 字体族、圆角阶梯、动效 token、全局 reset |
| `.../dsh-client-ui-theme/lib/styles/gradient-shadow-text.css` | 阴影 / elevation / 毛玻璃 / 字号复合简写 / markdown 排版 |
| `.../dsh-client-ui-theme/lib/styles/focus.css` | 全局焦点环 |
| `.../dsh-client-ui-theme/lib/styles/scrollbar.css` | 滚动条 |
| `.../dsh-client-ui-theme/lib/styles/corner-shape.css` | 超椭圆圆角 |
| `.../dsh-client-ui-theme/lib/styles/onboarding.css` | 引导页专用渐变与底色 |
| `.../dsh-client-ui-theme/lib/styles/shiki.css` | 代码高亮配色 |
| `.../dsh-web-frontend/dist/assets/index-*.css` | 元件库产物（按钮/标签页/标签/开关/输入/菜单/对话框/Toast/Tooltip/markdown/代码块 的实际 CSS） |
| `.../dsh-client-ui-layout/lib/client.js` | 三栏布局骨架（列宽契约、栅格、标题栏） |
| `.../dsh-client-ui-conversation/lib/client.js` | 会话骨架（页头高度、内容宽度、输入框卡片、消息流间距） |
| `.../dsh-client-ui-chat/lib/client.js` | 消息条目（用户气泡、消息流） |

## 1. 变量清单

### 1.1 static 层 + 形状 / 阴影 / 字体 / 动效（可直接复制的 `:root`）

```css
:root {
  --dsw-static-amber-100: #fef5e7;
  --dsw-static-amber-400: #f7ad31;
  --dsw-static-amber-500: #f59e0b;
  --dsw-static-amber-600: #dd8629;
  --dsw-static-amber-900: #27241f;
  --dsw-static-blue-100: #dbeafe;
  --dsw-static-blue-300: #93c5fd;
  --dsw-static-blue-400: #60a5fa;
  --dsw-static-blue-450: #4d93f8;
  --dsw-static-blue-50: #eff6ff;
  --dsw-static-blue-500: #3b82f6;
  --dsw-static-blue-50p: #eaf3ff;
  --dsw-static-blue-600: #2563eb;
  --dsw-static-blue-75: #e5f0ff;
  --dsw-static-blue-800: #1e40af;
  --dsw-static-blue-900: #0e3074;
  --dsw-static-blue-950: #172554;
  --dsw-static-deepseek-100: #e4edfd;
  --dsw-static-deepseek-200: #d3e2ff;
  --dsw-static-deepseek-300: #b7c8fe;
  --dsw-static-deepseek-400: #7aaaff;
  --dsw-static-deepseek-450: #5686fe;
  --dsw-static-deepseek-50: #edf3fe;
  --dsw-static-deepseek-500: #4176e6;
  --dsw-static-deepseek-600: #4868b2;
  --dsw-static-deepseek-700-delete: #2f4c8f;
  --dsw-static-deepseek-800: #34415b;
  --dsw-static-deepseek-900: #283142;
  --dsw-static-green-100: #e6faed;
  --dsw-static-green-400: #4ed17e;
  --dsw-static-green-500: #22c55e;
  --dsw-static-green-500-a08: #22c55e14;
  --dsw-static-green-500-a12: #22c55e1f;
  --dsw-static-green-900: #233c2c;
  --dsw-static-neutral-00: #fff;
  --dsw-static-neutral-100: #f5f5f5;
  --dsw-static-neutral-1000: #000;
  --dsw-static-neutral-150: #ededed;
  --dsw-static-neutral-200: #e5e5e5;
  --dsw-static-neutral-250: #dcdcdc;
  --dsw-static-neutral-300: #d4d4d4;
  --dsw-static-neutral-400: #a2a4a6;
  --dsw-static-neutral-50: #fafafa;
  --dsw-static-neutral-500: #7f8287;
  --dsw-static-neutral-550: #65676b;
  --dsw-static-neutral-600: #545557;
  --dsw-static-neutral-700: #3c3c3d;
  --dsw-static-neutral-800: #292929;
  --dsw-static-neutral-850: #212123;
  --dsw-static-neutral-900: #0f0f0f;
  --dsw-static-neutral-bluish-00: #fff;
  --dsw-static-neutral-bluish-100: #ebeef2;
  --dsw-static-neutral-bluish-1000: #0f1115;
  --dsw-static-neutral-bluish-150: #e9ecf2;
  --dsw-static-neutral-bluish-200: #e1e5ee;
  --dsw-static-neutral-bluish-300: #cfd3d6;
  --dsw-static-neutral-bluish-400: #adb2b8;
  --dsw-static-neutral-bluish-50: #f9fafb;
  --dsw-static-neutral-bluish-500: #979da6;
  --dsw-static-neutral-bluish-60: #f5f6f7;
  --dsw-static-neutral-bluish-600: #81858c;
  --dsw-static-neutral-bluish-700: #61666b;
  --dsw-static-neutral-bluish-75: #f1f3f5;
  --dsw-static-neutral-bluish-750: #43454a;
  --dsw-static-neutral-bluish-800: #353638;
  --dsw-static-neutral-bluish-850: #2c2c2e;
  --dsw-static-neutral-bluish-875: #232324;
  --dsw-static-neutral-bluish-900: #1b1b1c;
  --dsw-static-neutral-bluish-950: #151517;
  --dsw-static-red-100: #fee2e2;
  --dsw-static-red-400: #f25a5a;
  --dsw-static-red-400-a12: #f25a5a1f;
  --dsw-static-red-50: #fef2f2;
  --dsw-static-red-500: #ef4444;
  --dsw-static-red-600: #ec1313;
  --dsw-static-red-600-a08: #ec131314;
  --dsw-static-red-900: #570c0c;

  /* 圆角阶梯（base_css_default.css :root） */
  --dsw-radius-xs: 4px;
  --dsw-radius-sm: 8px;
  --dsw-radius-md: 12px;
  --dsw-radius-lg: 16px;
  --dsw-radius-xl: 20px;
  --dsw-radius-panel: 28px;

  /* 超椭圆圆角（corner_shape_css_default.css） */
  --dsw-corner-shape: superellipse(1.5);

  /* 阴影（gradient_shadow_text_css_default.css） */
  --dsw-shadow-lv1: 0 2px 4px 0 #0000000d;
  --dsw-shadow-lv1-blur: 0 4px 12px 0 #00000005;
  --dsw-shadow-lv2: 0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a;
  --dsw-shadow-lv3: 0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014;
  --dsw-elevation-stroke: 0 0 0 .5px var(--dsw-elevation-stroke-color);
  --dsw-elevation-panel: var(--dsw-elevation-stroke), 0 3px 8px 0 #00000008, 0 0 16px 0 #00000005;
  --dsw-elevation-prominent: var(--dsw-elevation-stroke), 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d;
  --dsw-elevation-soft: var(--dsw-elevation-stroke), 0 4px 16px 0 #00000008, 0 0 24px 0 #00000008;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l4);

  /* 材质与模糊 */
  --dsw-mask-blur: none;
  --dsw-menu-backdrop-filter: blur(40px) saturate(150%);

  /* 焦点环（focus_css_default.css） */
  --dsw-focus-ring-width: 2px;

  /* 字体族 */
  --dsh-font-family-text-default: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --dsw-font-family: var(--dsh-font-family-text-default);
  --dsw-font-family-brand: "Montserrat", var(--dsh-font-family-text-default);
  --dsh-font-family-code-default: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei";
  --ds-font-family-code: var(--dsh-font-family-code-default);

  /* 动效 */
  --ds-ease-in-out: cubic-bezier(.4, 0, .2, 1);
  --ds-transition-duration: .2s;
  --ds-transition-duration-fast: .1s;
  --ds-transition-duration-slow: .3s;

  /* 滚动条（scrollbar_css_default.css） */
  --dsh-scrollbar-width: 5px;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l1);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l1);
  --dsh-scrollbar-thumb-border: 0px;
  --dsh-scrollbar-track-margin: 0px;
}
```

> `--dsw-elevation-*` 与 `--dsw-elevation-stroke-color` 在源码里挂在 `body, body *` 上（而不是 `:root`），因为它们要能被局部覆盖（例如深色菜单、输入框卡片各自改 stroke 颜色）。上面把默认值并进 `:root` 只是方便复制，语义一致。

### 1.2 语义层 · 浅色（`:root` 或 `body` 均可，源码用的是 `body`）

```css
:root {
  --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-bg-document-preview: var(--dsw-static-neutral-bluish-100);
  --dsw-alias-bg-document-selection: color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent);
  --dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-bg-layer-3: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-bg-mask-1: #0000003d;
  --dsw-alias-bg-mask-2: #0000001f;
  --dsw-alias-bg-mask-3: #0000007a;
  --dsw-alias-bg-mask-drop: #ffffffb3;
  --dsw-alias-bg-mask-photo: #000000e0;
  --dsw-alias-bg-module-platform: var(--dsw-static-neutral-bluish-60);
  --dsw-alias-bg-multi-select: var(--dsw-static-neutral-bluish-60);
  --dsw-alias-bg-overlay: var(--dsw-static-neutral-bluish-150);
  --dsw-alias-bg-skeleton: #0000000a;
  --dsw-alias-border-inverted: #0000;
  --dsw-alias-border-inverted2: #0000;
  --dsw-alias-border-l1: #0000000a;
  --dsw-alias-border-l2: #0000001a;
  --dsw-alias-border-l2-darkmode-thin: #0000001a;
  --dsw-alias-border-l3: #0000001f;
  --dsw-alias-border-l4: #00000029;
  --dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-brand-primary-invert: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-brand-primary-new-colorprimary-new-color: #4176e6;
  --dsw-alias-brand-text: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-button-contrast-fill: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-button-elevated-fill: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-button-floating-fill: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-button-floating-hover: var(--dsw-static-neutral-bluish-75);
  --dsw-alias-button-ghost-active-border: var(--dsw-static-neutral-bluish-500);
  --dsw-alias-button-ghost-active-fill: var(--dsw-static-neutral-bluish-100);
  --dsw-alias-button-ghost-active-hover: var(--dsw-static-neutral-bluish-150);
  --dsw-alias-button-info-fill: var(--dsw-static-deepseek-500);
  --dsw-alias-button-info-hover: var(--dsw-static-deepseek-400);
  --dsw-alias-button-primary-dimmed: var(--dsw-static-neutral-bluish-100);
  --dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary);
  --dsw-alias-button-primary-hover: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-button-tool-bar-fill: #54555780;
  --dsw-alias-button-tool-bar-fill-invisible: #1f1f1f5c;
  --dsw-alias-button-tool-bar-hover: #54555799;
  --dsw-alias-code-diff-added: var(--dsw-static-green-500-a08);
  --dsw-alias-code-diff-deleted: var(--dsw-static-red-600-a08);
  --dsw-alias-file-diff-added-bg: #e6f4e7;
  --dsw-alias-file-diff-added-gutter: #edf7ed;
  --dsw-alias-file-diff-added-marker: #01a241;
  --dsw-alias-file-diff-deleted-bg: #fce6e2;
  --dsw-alias-file-diff-deleted-gutter: #fdece9;
  --dsw-alias-file-diff-deleted-marker: #ba2723;
  --dsw-alias-interactive-bg-active: #2631481a;
  --dsw-alias-interactive-bg-hover: #2631480f;
  --dsw-alias-interactive-bg-hover-accent: #26314824;
  --dsw-alias-interactive-bg-hover-danger: #ec13130d;
  --dsw-alias-interactive-bg-hover-solid: var(--dsw-static-neutral-bluish-75);
  --dsw-alias-label-caption: var(--dsw-static-neutral-bluish-400);
  --dsw-alias-label-deep-diving: color-mix(in srgb, var(--dsw-static-deepseek-500) 70%, var(--dsw-static-blue-950));
  --dsw-alias-label-deep-diving-shimmer: color-mix(in srgb, var(--dsw-static-deepseek-500) 30%, var(--dsw-static-blue-950));
  --dsw-alias-label-dimmed: var(--dsw-static-neutral-bluish-200);
  --dsw-alias-label-document-preview: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-label-primary: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-label-primary-bluish: var(--dsw-static-blue-900);
  --dsw-alias-label-primary-dimmed: var(--dsw-static-neutral-bluish-950);
  --dsw-alias-label-primary-foreground: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-label-primary-inverted: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-label-shimmer: color-mix(in srgb, var(--dsw-static-neutral-1000) 30%, transparent);
  --dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-600);
  --dsw-alias-link: var(--dsw-static-deepseek-500);
  --dsw-alias-markdown-citation: var(--dsw-static-neutral-bluish-100);
  --dsw-alias-markdown-code-block: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-markdown-code-block-banner: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-markdown-code-segment-selected: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-markdown-code-segment-unselected: var(--dsw-static-neutral-bluish-75);
  --dsw-alias-markdown-inline-code: var(--dsw-static-neutral-50);
  --dsw-alias-markdown-placeholder: var(--dsw-static-neutral-bluish-60);
  --dsw-alias-markdown-tag: var(--dsw-static-neutral-bluish-75);
  --dsw-alias-menu-group-header-fill: #f8f9faf0;
  --dsw-alias-menu-icon: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-scrollbar-bg-l1: var(--dsw-static-neutral-200);
  --dsw-alias-scrollbar-bg-l2: var(--dsw-static-neutral-200);
  --dsw-alias-scrollbar-hover-l1: var(--dsw-static-neutral-300);
  --dsw-alias-scrollbar-hover-l2: var(--dsw-static-neutral-300);
  --dsw-alias-state-business-primary: var(--dsw-static-deepseek-500);
  --dsw-alias-state-business-tertiary: var(--dsw-static-deepseek-100);
  --dsw-alias-state-error-primary: var(--dsw-static-red-600);
  --dsw-alias-state-error-secondary: var(--dsw-static-red-400);
  --dsw-alias-state-idle-primary: var(--dsw-static-neutral-300);
  --dsw-alias-state-success-primary: var(--dsw-static-green-500);
  --dsw-alias-state-success-secondary: var(--dsw-static-green-400);
  --dsw-alias-state-success-tertiary: var(--dsw-static-green-100);
  --dsw-alias-state-warn-label: var(--dsw-static-amber-600);
  --dsw-alias-state-warn-primary: var(--dsw-static-amber-500);
  --dsw-alias-state-warn-secondary: var(--dsw-static-amber-400);
  --dsw-alias-state-warn-tertiary: var(--dsw-static-amber-100);
  --dsw-alias-switch-thumb: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-toast-bg: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-toast-label: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-tooltip-bg: var(--dsw-static-neutral-bluish-850);
  --dsw-alias-tooltip-key-bg: color-mix(in srgb, var(--dsw-alias-tooltip-bg), white 18%);
  --dsw-alias-turn-trigger-bg: var(--dsw-alias-markdown-code-block);
  --dsw-alias-turn-trigger-bg-hover: var(--dsw-alias-interactive-bg-hover);
  --dsw-menu-surface-fill: #f8f9fa94;
  --dsw-specific-bubble: var(--dsw-static-deepseek-50);
  --dsw-specific-bubble-highlight: var(--dsw-static-deepseek-200);
  --dsw-specific-input-major: var(--dsw-static-neutral-bluish-00);
  --dsw-specific-login-input: var(--dsw-static-neutral-bluish-50);
  --dsw-specific-menu: #f8f9faf0;
  --dsw-specific-selector: var(--dsw-static-neutral-bluish-60);
  --dsw-specific-sidebar-fill: var(--dsw-static-neutral-bluish-50);
  --dsw-specific-sidebar-nav-item-active: var(--dsw-static-neutral-bluish-100);
  --dsw-specific-sidebar-nav-item-active-accent: var(--dsw-static-deepseek-100);
  --dsw-specific-sidebar-nav-item-hover: var(--dsw-static-neutral-bluish-75);
  --dsw-specific-tip: var(--dsw-static-neutral-bluish-60);
}
```

### 1.3 语义层 · 深色

```css
body[data-ds-dark-theme] {
  --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-950);
  --dsw-alias-bg-document-preview: var(--dsw-static-neutral-bluish-950);
  --dsw-alias-bg-document-selection: color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent);
  --dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-875);
  --dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-850);
  --dsw-alias-bg-layer-3: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-bg-mask-1: #00000080;
  --dsw-alias-bg-mask-2: #0003;
  --dsw-alias-bg-mask-3: #0000007a;
  --dsw-alias-bg-mask-drop: #272730b3;
  --dsw-alias-bg-mask-photo: #000000e0;
  --dsw-alias-bg-module-platform: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-bg-multi-select: var(--dsw-static-neutral-850);
  --dsw-alias-bg-overlay: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-bg-skeleton: #ffffff14;
  --dsw-alias-border-inverted: #ffffff0f;
  --dsw-alias-border-inverted2: #ffffff14;
  --dsw-alias-border-l1: #ffffff0f;
  --dsw-alias-border-l2: #ffffff1f;
  --dsw-alias-border-l2-darkmode-thin: #ffffff0f;
  --dsw-alias-border-l3: #ffffff29;
  --dsw-alias-border-l4: #fff3;
  --dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-brand-primary-invert: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-brand-primary-new-colorprimary-new-color: var(--dsw-static-deepseek-450);
  --dsw-alias-brand-text: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-button-contrast-fill: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-button-elevated-fill: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-button-floating-fill: var(--dsw-static-neutral-bluish-850);
  --dsw-alias-button-floating-hover: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-button-ghost-active-border: var(--dsw-static-neutral-bluish-600);
  --dsw-alias-button-ghost-active-fill: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-button-ghost-active-hover: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-button-info-fill: var(--dsw-static-deepseek-400);
  --dsw-alias-button-info-hover: var(--dsw-static-deepseek-500);
  --dsw-alias-button-primary-dimmed: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary);
  --dsw-alias-button-primary-hover: var(--dsw-static-neutral-bluish-100);
  --dsw-alias-button-tool-bar-fill: #54555780;
  --dsw-alias-button-tool-bar-fill-invisible: #1f1f1f5c;
  --dsw-alias-button-tool-bar-hover: #54555799;
  --dsw-alias-code-diff-added: var(--dsw-static-green-500-a12);
  --dsw-alias-code-diff-deleted: var(--dsw-static-red-400-a12);
  --dsw-alias-file-diff-added-bg: #1f3124;
  --dsw-alias-file-diff-added-gutter: #132016;
  --dsw-alias-file-diff-added-marker: #41c977;
  --dsw-alias-file-diff-deleted-bg: #3c1f1b;
  --dsw-alias-file-diff-deleted-gutter: #28130e;
  --dsw-alias-file-diff-deleted-marker: #fa423e;
  --dsw-alias-interactive-bg-active: #ffffff24;
  --dsw-alias-interactive-bg-hover: #ffffff14;
  --dsw-alias-interactive-bg-hover-accent: #ffffff3d;
  --dsw-alias-interactive-bg-hover-danger: #f25a5a26;
  --dsw-alias-interactive-bg-hover-solid: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-label-caption: var(--dsw-static-neutral-bluish-600);
  --dsw-alias-label-deep-diving: color-mix(in srgb, var(--dsw-static-deepseek-450) 55%, var(--dsw-static-neutral-bluish-400));
  --dsw-alias-label-deep-diving-shimmer: color-mix(in srgb, var(--dsw-static-blue-300) 65%, var(--dsw-static-deepseek-400));
  --dsw-alias-label-dimmed: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-label-document-preview: var(--dsw-static-neutral-bluish-300);
  --dsw-alias-label-primary: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-label-primary-bluish: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-label-primary-dimmed: var(--dsw-static-neutral-bluish-100);
  --dsw-alias-label-primary-foreground: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-label-primary-inverted: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-300);
  --dsw-alias-label-shimmer: color-mix(in srgb, var(--dsw-static-neutral-00) 45%, transparent);
  --dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-400);
  --dsw-alias-link: var(--dsw-static-deepseek-400);
  --dsw-alias-markdown-citation: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-markdown-code-block: var(--dsw-static-neutral-bluish-900);
  --dsw-alias-markdown-code-block-banner: var(--dsw-static-neutral-bluish-850);
  --dsw-alias-markdown-code-segment-selected: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-markdown-code-segment-unselected: var(--dsw-static-neutral-bluish-900);
  --dsw-alias-markdown-inline-code: var(--dsw-static-neutral-800);
  --dsw-alias-markdown-placeholder: var(--dsw-static-neutral-bluish-850);
  --dsw-alias-markdown-tag: var(--dsw-static-neutral-bluish-850);
  --dsw-alias-menu-group-header-fill: #303136f0;
  --dsw-alias-menu-icon: var(--dsw-alias-label-primary-dimmed);
  --dsw-alias-scrollbar-bg-l1: var(--dsw-static-neutral-700);
  --dsw-alias-scrollbar-bg-l2: var(--dsw-static-neutral-600);
  --dsw-alias-scrollbar-hover-l1: var(--dsw-static-neutral-600);
  --dsw-alias-scrollbar-hover-l2: var(--dsw-static-neutral-550);
  --dsw-alias-state-business-primary: var(--dsw-static-deepseek-400);
  --dsw-alias-state-business-tertiary: var(--dsw-static-deepseek-800);
  --dsw-alias-state-error-primary: var(--dsw-static-red-400);
  --dsw-alias-state-error-secondary: var(--dsw-static-red-400);
  --dsw-alias-state-idle-primary: var(--dsw-static-neutral-600);
  --dsw-alias-state-success-primary: var(--dsw-static-green-500);
  --dsw-alias-state-success-secondary: var(--dsw-static-green-400);
  --dsw-alias-state-success-tertiary: var(--dsw-static-green-900);
  --dsw-alias-state-warn-label: var(--dsw-static-amber-600);
  --dsw-alias-state-warn-primary: var(--dsw-static-amber-500);
  --dsw-alias-state-warn-secondary: var(--dsw-static-amber-400);
  --dsw-alias-state-warn-tertiary: var(--dsw-static-amber-900);
  --dsw-alias-switch-thumb: var(--dsw-static-neutral-bluish-400);
  --dsw-alias-toast-bg: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-toast-label: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-tooltip-bg: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-tooltip-key-bg: color-mix(in srgb, var(--dsw-alias-tooltip-bg), white 18%);
  --dsw-alias-turn-trigger-bg: var(--dsw-alias-interactive-bg-hover);
  --dsw-alias-turn-trigger-bg-hover: var(--dsw-alias-interactive-bg-active);
  --dsw-menu-surface-fill: #43454a73;
  --dsw-specific-bubble: var(--dsw-static-neutral-bluish-850);
  --dsw-specific-bubble-highlight: var(--dsw-static-neutral-bluish-750);
  --dsw-specific-input-major: var(--dsw-static-neutral-bluish-850);
  --dsw-specific-login-input: var(--dsw-static-neutral-bluish-900);
  --dsw-specific-menu: #303136f0;
  --dsw-specific-selector: var(--dsw-static-neutral-bluish-800);
  --dsw-specific-sidebar-fill: var(--dsw-static-neutral-bluish-900);
  --dsw-specific-sidebar-nav-item-active: var(--dsw-static-neutral-bluish-750);
  --dsw-specific-sidebar-nav-item-active-accent: var(--dsw-static-neutral-bluish-800);
  --dsw-specific-sidebar-nav-item-hover: var(--dsw-static-neutral-bluish-850);
  --dsw-specific-tip: var(--dsw-static-neutral-bluish-800);
}
```

### 1.4 字号复合简写

源码把每种字号拆成一个复合简写 + 6 个分量变量（`-font-family` / `-font-size` / `-font-weight` / `-line-height` / `-font-style`），组件用 `font: var(--dsw-font-s-14)` 一句话拿到全套。完整清单见 `gradient-shadow-text.css`；最常用的 13 条：

```css
:root {
  --dsw-font-xl-24: 600 24px/32px var(--dsw-font-family);
  --dsw-font-l-20: 500 20px/28px var(--dsw-font-family);
  --dsw-font-m-18: 500 16px/28px var(--dsw-font-family); /* 名字叫 18，实际是 16px */
  --dsw-font-base-16: 16px/24px var(--dsw-font-family);
  --dsw-font-base-strong-16: 500 16px/24px var(--dsw-font-family);
  --dsw-font-s-14: 14px/22px var(--dsw-font-family);
  --dsw-font-s-strong-14: 500 14px/22px var(--dsw-font-family);
  --dsw-font-xs-13: 13px/20px var(--dsw-font-family);
  --dsw-font-xs-strong-13: 500 13px/20px var(--dsw-font-family);
  --dsw-font-xxs-12: 12px/18px var(--dsw-font-family);
  --dsw-font-xxs-strong-12: 500 12px/18px var(--dsw-font-family);
  --dsw-font-xxxs-11: 11px/14px var(--dsw-font-family);
  --dsw-font-xxxs-strong-11: 500 11px/14px var(--dsw-font-family);
  
  /* markdown 正文排版，随用户字号设置缩放（--dsh-content-font-size 默认 14px） */
  --dsw-font-markdown-h1: 700 calc(21px + var(--dsh-content-font-delta)) / calc(30px + var(--dsh-content-font-delta)) var(--dsw-font-family);
  --dsw-font-markdown-h2: 700 calc(19px + var(--dsh-content-font-delta)) / calc(28px + var(--dsh-content-font-delta)) var(--dsw-font-family);
  --dsw-font-markdown-h3: 700 calc(18px + var(--dsh-content-font-delta)) / calc(26px + var(--dsh-content-font-delta)) var(--dsw-font-family);
  --dsw-font-markdown-h4: 600 var(--dsh-content-font-size, 14px) / calc(24px + var(--dsh-content-font-delta)) var(--dsw-font-family);
  --dsw-font-markdown-base: var(--dsh-content-font-size, 14px) / calc(24px + var(--dsh-content-font-delta)) var(--dsw-font-family);
  --dsw-font-markdown-small: 12px/20px var(--dsw-font-family);
  --dsw-font-markdown-code: calc(12px + var(--dsh-code-font-delta)) / calc(19px + var(--dsh-code-font-delta)) var(--ds-font-family-code);
  --dsw-font-markdown-code-block: var(--dsh-code-font-size, 11px) / calc(19px + var(--dsh-code-font-delta)) var(--ds-font-family-code);
}
```

## 2. 颜色体系

### 2.1 关键语义色（解析值 = 顺着 `var()` 链把 static 色值代进去的结果，非我自创）

**背景层级**

| 变量 | 浅色解析值 | 深色解析值 |
| --- | --- | --- |
| `--dsw-alias-bg-base` | `#fff` | `#151517` |
| `--dsw-alias-bg-layer-1` | `#fff` | `#232324` |
| `--dsw-alias-bg-layer-2` | `#fff` | `#2c2c2e` |
| `--dsw-alias-bg-layer-3` | `#fff` | `#353638` |
| `--dsw-alias-bg-module-platform` | `#f5f6f7` | `#353638` |
| `--dsw-alias-bg-overlay` | `#e9ecf2` | `#61666b` |
| `--dsw-alias-bg-skeleton` | `#0000000a` | `#ffffff14` |
| `--dsw-specific-sidebar-fill` | `#f9fafb` | `#1b1b1c` |
| `--dsw-specific-input-major` | `#fff` | `#2c2c2e` |
| `--dsw-specific-menu` | `#f8f9faf0` | `#303136f0` |

**文字层级**

| 变量 | 浅色解析值 | 深色解析值 |
| --- | --- | --- |
| `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` |
| `--dsw-alias-label-tertiary` | `#81858c` | `#adb2b8` |
| `--dsw-alias-label-caption` | `#adb2b8` | `#81858c` |
| `--dsw-alias-label-dimmed` | `#e1e5ee` | `#43454a` |
| `--dsw-alias-label-primary-foreground` | `#fff` | `#0f1115` |
| `--dsw-alias-link` | `#4176e6` | `#7aaaff` |

**主色 / 强调**

| 变量 | 浅色解析值 | 深色解析值 |
| --- | --- | --- |
| `--dsw-alias-brand-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-button-primary-fill` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-state-business-primary` | `#4176e6` | `#7aaaff` |
| `--dsw-alias-button-info-fill` | `#4176e6` | `#7aaaff` |

**状态色**

| 变量 | 浅色解析值 | 深色解析值 |
| --- | --- | --- |
| `--dsw-alias-state-success-primary` | `#22c55e` | `#22c55e` |
| `--dsw-alias-state-warn-primary` | `#f59e0b` | `#f59e0b` |
| `--dsw-alias-state-warn-label` | `#dd8629` | `#dd8629` |
| `--dsw-alias-state-error-primary` | `#ec1313` | `#f25a5a` |
| `--dsw-alias-state-idle-primary` | `#d4d4d4` | `#545557` |

**边框**

| 变量 | 浅色解析值 | 深色解析值 |
| --- | --- | --- |
| `--dsw-alias-border-l1` | `#0000000a` | `#ffffff0f` |
| `--dsw-alias-border-l2` | `#0000001a` | `#ffffff1f` |
| `--dsw-alias-border-l3` | `#0000001f` | `#ffffff29` |
| `--dsw-alias-border-l4` | `#00000029` | `#fff3` |

**交互底色**

| 变量 | 浅色解析值 | 深色解析值 |
| --- | --- | --- |
| `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` |
| `--dsw-alias-interactive-bg-active` | `#2631481a` | `#ffffff24` |
| `--dsw-alias-interactive-bg-hover-solid` | `#f1f3f5` | `#353638` |
| `--dsw-alias-interactive-bg-hover-danger` | `#ec13130d` | `#f25a5a26` |

**聊天气泡 / 代码**

| 变量 | 浅色解析值 | 深色解析值 |
| --- | --- | --- |
| `--dsw-specific-bubble` | `#edf3fe` | `#2c2c2e` |
| `--dsw-specific-bubble-highlight` | `#d3e2ff` | `#43454a` |
| `--dsw-alias-markdown-code-block` | `#f9fafb` | `#1b1b1c` |
| `--dsw-alias-markdown-code-block-banner` | `#f9fafb` | `#2c2c2e` |
| `--dsw-alias-markdown-inline-code` | `#fafafa` | `#292929` |

### 2.2 层级关系速记

- **浅色**：`bg-base` = `#fff`；`bg-layer-1/2/3` 三个面板层在浅色下**全是 `#fff`**，靠 `elevation` 的描边阴影区分，不靠底色深浅。真正有色差的是 `bg-module-platform #f5f6f7`（标签页槽位）、`specific-sidebar-fill #f9fafb`、`specific-menu #f8f9faf0`（毛玻璃）。
- **深色**：`bg-base #151517` → `layer-1 #232324` → `layer-2 #2c2c2e` → `layer-3 #353638`，逐层提亮；`specific-sidebar-fill #1b1b1c` 比 base 亮一档，侧边栏浮在底色之上。
- **强调色是「反转中性色」**：`brand-primary` 浅色 `#0f1115`（近黑）、深色 `#f9fafb`（近白）。主按钮＝黑白反转按钮，不是品牌蓝。真正偏蓝的是 `state-business-primary`（浅 `#4176e6` / 深 `#7aaaff`）与 `link`。
- **边框极细**：l1 `rgba(0,0,0,.04)` 级别，全站大量 `.5px` 实线（不是 1px），这是 DSH 视觉上「轻」的主要来源。

## 3. 排版

**字体族**（`base.css`）：

```css
--dsw-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
--dsw-font-family-brand: "Montserrat", var(--dsw-font-family);
--ds-font-family-code: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei";
```

中文回退顺序是 `PingFang SC → Hiragino Sans GB → Microsoft YaHei`；代码字体里也带中文回退，避免中文等宽错位。品牌字 Montserrat 只用于欢迎页/字标。

**字号阶梯**：24 / 20 / 16 / 14 / 13 / 12 / 11，行高基本是字号的 1.33–1.5 倍（24→32、20→28、16→24~28、14→22、13→20、12→18、11→14）。

**字重只有三档**：400（正文）、500（`strong` 系列 / 按钮 / 小标题 / 标签）、600–700（对话框标题、markdown h1–h3、选中标签）。没有 800/900。

**UI 正文基准是 14px/22px**，聊天正文按 `--dsh-content-font-size`（默认 14px）缩放，行高随之用 `calc(24px + delta)` 补偿。

## 4. 形状、间距、阴影

### 4.1 圆角阶梯

| token | 值 | 典型用途 |
| --- | --- | --- |
| `--dsw-radius-xs` | 4px | 行内代码、JSON 树小按钮 |
| `--dsw-radius-sm` | 8px | 小按钮、菜单项、输入框、提示气泡、代码块内滚动条 |
| `--dsw-radius-md` | 12px | 默认按钮、标签页、搜索框、菜单容器 |
| `--dsw-radius-lg` | 16px | 菜单面板、代码块、Toast、hovercard、标签页槽位 |
| `--dsw-radius-xl` | 20px | 用户消息气泡 |
| `--dsw-radius-panel` | 28px | 对话框、输入框卡片、浮动窗口 |
| `999px` | 胶囊 | 标签（tag）、状态 pill、滚动条、开关 |

另外全局启用超椭圆圆角：`* { corner-shape: var(--dsw-corner-shape) }`，值为 `superellipse(1.5)`（仅在支持的浏览器生效，`@supports` 包裹）。需要正圆的地方显式写 `corner-shape: round`（胶囊、开关、把手）。

### 4.2 间距

**DSH 没有间距 token 体系**（全仓库 grep 不到 `--dsw-spacing-*` 之类），组件直接写 px。实际出现频率最高的值构成事实上的阶梯：

`2 / 4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 22 / 24 / 28 / 32`（px）。其中 4、8、12、16 是骨架值，6px 专门用于「图标+文字」间隙和消息流最小间距，28px 是面板内边距与页头左右留白。

### 4.3 边框宽度

- 分隔线、卡片描边、输入框边框：**`.5px`**（绝对主流）。
- 焦点环：`2px` outline（`--dsw-focus-ring-width`），部分小控件内联用 `1px`。
- 引用块左边线：`2px`；代码 diff 行左侧标记：`inset 3px`。

### 4.4 阴影层级

```css
--dsw-shadow-lv1: 0 2px 4px 0 #0000000d;                                  /* 轻浮起 */
--dsw-shadow-lv2: 0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a;          /* 卡片 */
--dsw-shadow-lv3: 0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014; /* Toast / hovercard */
--dsw-elevation-stroke: 0 0 0 .5px var(--dsw-elevation-stroke-color);      /* 半像素描边，代替 border */
--dsw-elevation-panel:      stroke + 0 3px 8px #00000008 + 0 0 16px #00000005;
--dsw-elevation-prominent:  stroke + 0 3px 8px #0000000a + 0 0 20px #0000000d;
--dsw-elevation-soft:       stroke + 0 4px 16px #00000008 + 0 0 24px #00000008;
```

关键手法：**用 `box-shadow: 0 0 0 .5px` 画描边**而不是 `border`，这样描边不占布局、圆角处更干净；深色下把 `--dsw-elevation-stroke-color` 从 `border-l4` 换成 `border-l3`（菜单材质另用 l3），让深色描边更可见。

## 5. 组件

### 5.1 按钮

基础 `.button`：`inline-flex`、`gap:4px`、`border:none`、圆角 `radius-md`、字号 `14px/22px`、左右内距 `14px`；尺寸两档 `md = 36px` 高、`sm = 28px` 高（字号降到 12/18、内距 10px、圆角 `radius-sm`）。禁用态 `opacity:.4`。

变体（实际就是四种）：

```css
.button { display:inline-flex; align-items:center; justify-content:center; gap:4px;
  border:none; border-radius:var(--dsw-radius-md); padding:0 14px;
  font-size:14px; line-height:22px; color:var(--dsw-alias-label-primary); background:transparent; cursor:pointer; }
.button--md { height:36px; }
.button--sm { height:28px; font-size:12px; line-height:18px; padding:0 10px; border-radius:var(--dsw-radius-sm); }

/* 主按钮：黑白反转 */
.button--primary { background:var(--dsw-alias-button-primary-fill); color:var(--dsw-alias-label-primary-foreground); }
.button--primary:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover); }

/* 次按钮：透明底 + 半像素描边 */
.button--outline { border:.5px solid var(--dsw-alias-border-l3); background:transparent; }
.button--outline:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }

/* 幽灵按钮：只有 hover 底色 */
.button--ghost:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.button--ghost:active:not(:disabled) { background:var(--dsw-alias-interactive-bg-active); }

/* 工具条按钮（图标底） */
.button--toolbar { background:var(--dsw-alias-button-tool-bar-fill); }
.button--toolbar:hover:not(:disabled) { background:var(--dsw-alias-button-tool-bar-hover); }
```

**危险按钮**：DSH 没有独立的 `--danger` 按钮变体，危险动作走「红字幽灵」——文字用 `--dsw-alias-state-error-primary`，hover 底色用 `--dsw-alias-interactive-bg-hover-danger`（浅 `#ec13130d` / 深 `#f25a5a26`）。这是我从别名变量的消费点归纳的用法（**推断用法**，非单一选择器）。

图标按钮统一 `16×16` 容器，图标本身 `display:inline-flex` 居中。

### 5.2 输入框

两种形态。**搜索/行内输入**是「包裹盒」：

```css
.search { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 8px;
  border:.5px solid var(--dsw-alias-border-l4); border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1); }
.search:focus-within { border-color:var(--dsw-alias-state-business-primary); }  /* 聚焦只换描边色，不加焦点环 */
.search input { flex:1; min-width:0; border:none; outline:none; background:transparent;
  font-size:14px; line-height:22px; color:var(--dsw-alias-label-primary); }
.search input::placeholder { color:var(--dsw-alias-label-dimmed); }
.search .icon { width:16px; height:16px; color:var(--dsw-alias-label-tertiary); }
```

**表单输入**（设置页那种）`height:34px; padding:0 12px; border:.5px solid border-l4; radius-md; background:bg-layer-3; font-size:13px`，聚焦同样是「换描边色 + 去 outline」，`aria-invalid=true` 时描边换成 `state-error-primary`。

**多行编辑器**：`padding:3px 8px`、`radius-sm`、`border:.5px border-l4`、`background:bg-base`、字号 13/20、`resize:none`，高度 28–127px 自适应；聚焦换描边色。

**聊天输入框（Composer）**：这是 DSH 的招牌组件——一张 `radius-panel`（28px）的浮起卡片，背景 `specific-input-major`，阴影 `elevation-soft`，内部 `gap:12px`、`padding-top:8px`，编辑区最大高 `336px` 后内部滚动，卡片最大宽 = 内容宽 + 32px。

```css
.composer-card { box-sizing:border-box; width:100%; max-width:calc(var(--dsh-chat-content-width) + 32px);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
  border:0; border-radius:var(--dsw-radius-panel); background:var(--dsw-specific-input-major);
  box-shadow:var(--dsw-elevation-soft); display:flex; flex-direction:column; gap:12px; padding-top:8px; }
.composer-scroll { max-height:336px; margin-right:4px; overflow-y:auto; }
```

### 5.3 对话框与弹层

```css
.mask { position:absolute; inset:0; backdrop-filter:var(--dsw-mask-blur); }      /* 默认 none：不糊背景 */
.mask::after { content:""; position:absolute; inset:0; background:var(--dsw-alias-bg-mask-1);
  animation: fadeIn var(--ds-transition-duration) var(--ds-ease-in-out); }
.dialog { position:relative; z-index:1; display:flex; flex-direction:column; gap:20px;
  width:min(380px,100%); padding:0 0 24px; border:0; overflow:hidden;
  border-radius:var(--dsw-radius-panel); background:var(--dsw-alias-bg-layer-2);
  box-shadow:var(--dsw-elevation-prominent);
  animation: fadeIn var(--ds-transition-duration) var(--ds-ease-in-out); }
.dialog-header { display:flex; align-items:center; justify-content:space-between; gap:8px;
  padding:22px 14px 12px 24px; }
@keyframes fadeIn { 0% { opacity:0 } to { opacity:1 } }
```

要点：遮罩用 `--dsw-alias-bg-mask-1`（浅 `#0000003d` / 深 `#00000080`），`--dsw-mask-blur` 默认是 `none`（不启用背景模糊，只有显式改它才会糊）；对话框本体是 `radius-panel` + `elevation-prominent`，进出场只有透明度渐变，没有位移缩放。

**菜单 / 弹出层**用「毛玻璃材质」：

```css
.menu-material { background:var(--dsw-menu-surface-fill);          /* 浅 #f8f9fa94 / 深 #43454a73 */
  backdrop-filter:var(--dsw-menu-backdrop-filter); }               /* blur(40px) saturate(150%) */
.menu-list { box-sizing:border-box; padding:4px; display:flex; flex-direction:column;
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent); border-radius:var(--dsw-radius-lg); }
```

**Tooltip**：`radius-sm`、背景 `tooltip-bg`（近黑）、文字纯白、`13px/20px`、`padding:3px 7px`、`max-width:50vw`、入场只有 `opacity`，`.15s var(--ds-ease-in-out)`。

**Toast**：`position:fixed; top:40px` 居中、`radius-lg`、背景 `toast-bg`、`padding:12px 16px`、`shadow-lv3`、最大宽 `min(640px, 100vw-48px)`，入场 `.16s ease-out`（透明 + 上移 6px），停留 3s 后 1s 淡出。

**Hovercard**：`radius-lg` + `shadow-lv3`，深色下底色写死 `#2C2C2E`（`--dsw-hovercard-bg`）。

### 5.4 侧边栏

骨架由 `ui-layout` 的三列 grid 决定（见第 6 节），侧边栏列本身：

```css
.sidebar-col { background:var(--dsw-specific-sidebar-fill);
  border-right:.5px solid var(--dsw-alias-border-l3); min-width:0; overflow:hidden; }
```

macOS 上额外叠一层品牌渐变并去掉右边线（`ui-layout` 里写死）：

```css
[data-platform=darwin] .sidebar-col {
  background: linear-gradient(to bottom, #7a9bf01a, #7a9bf000 35%, #8f89b800 68%, #8f89b817),
              color-mix(in srgb, color-mix(in srgb, var(--dsw-specific-sidebar-fill) 97%, #7a9bf0) 40%, transparent);
  border-right:none; }
```

导航项（会话/项目条目）语义色齐全但**组件 CSS 未定位到**（见第 8 节）：`--dsw-specific-sidebar-nav-item-active`（浅 `#ebeef2` / 深 `#43454a`）、`-hover`（浅 `#f1f3f5` / 深 `#2c2c2e`），「当前会话」还多一层 `-active-accent`（浅 `#e4edfd` 淡蓝 / 深 `#353638`）。

### 5.5 标签页

**胶囊式分段标签页**（对话/轨迹切换那种）：外层 `grid` + `padding:4px` + `radius-lg` + 背景 `bg-module-platform`，激活块是一个绝对定位的 `.indicator`（`radius-md`、背景 `bg-layer-3`、`.5px` 描边），靠 `transform` 平移，`.18s ease`。

```css
.tabs { position:relative; display:grid; padding:4px; border-radius:var(--dsw-radius-lg);
  background:var(--dsw-alias-bg-module-platform); }
.tabs-indicator { position:absolute; inset:4px auto 4px 4px; box-sizing:border-box;
  border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-3); transition:transform .18s ease; pointer-events:none; }
.tab { position:relative; height:34px; padding:0 12px; border-radius:var(--dsw-radius-md);
  font-size:14px; line-height:20px; background:transparent; color:var(--dsw-alias-label-secondary);
  transition:color .18s ease; justify-content:center; }
.tab[aria-selected=true] { color:var(--dsw-alias-label-primary); font-weight:600; }
.tab:focus-visible { outline:none; text-decoration:underline; text-underline-offset:4px; }
```

注意一个细节：标签页获得焦点时**不用外框，改用下划线**（`text-decoration`），这在桌面应用里更贴合。

**紧凑分段控件**（Markdown/源码切换）：容器 `padding:4px; gap:2px; radius-md`，背景 `interactive-bg-hover`；滑块 `radius-sm` + `elevation-soft`，`.16s ease`；按钮高 28px、`padding:0 16px`、13/20 字重 500。

### 5.6 消息气泡

用户消息右对齐，气泡 `radius-xl`（20px）、背景 `--dsw-specific-bubble`、`padding:10px 16px`、`white-space:pre-wrap`；宽度上限是「内容宽 × 0.702」与「82%」取小：

```css
.user-row { display:flex; flex-direction:column; align-items:flex-end; gap:6px; }
.user-stack { min-width:0; display:flex; flex-direction:column; align-items:flex-end; gap:8px;
  max-width:min(calc(var(--dsh-chat-content-width, 748px) * .702), 82%); }
.bubble { background:var(--dsw-specific-bubble); border-radius:var(--dsw-radius-xl); max-width:100%;
  padding:10px 16px; white-space:pre-wrap; word-break:break-word;
  font-size:var(--dsh-content-font-size, 14px);
  line-height:calc(22px + var(--dsh-content-font-delta, 0px)); color:var(--dsw-alias-label-primary); }
```

助手消息**没有气泡**——就是文档流里的 markdown（左对齐、无背景），靠内容宽约束和间距区分。气泡内「高亮」态用 `--dsw-specific-bubble-highlight`。

### 5.7 代码块

代码块是一只带「横幅」的圆角卡片：`radius-lg`、背景 `--dsw-alias-markdown-code-block`、`margin:16px 0`；横幅（语言名 + 复制按钮）`padding:9px 14px`、字号 `11px/18px`、背景 `markdown-code-block-banner`、吸顶（`position:sticky; top:0`）；正文 `pre` 内距 `16px`、字号默认 11px/19px 等宽。

```css
.code-block { position:relative; margin:16px 0; border-radius:var(--dsw-radius-lg);
  background:var(--dsw-alias-markdown-code-block); color:var(--dsw-alias-label-primary); }
.code-block-banner { position:sticky; top:0; z-index:6; display:flex; justify-content:space-between;
  align-items:center; gap:12px; padding:9px 14px; background:var(--dsw-alias-markdown-code-block-banner);
  font:11px/18px var(--dsw-font-family);
  border-radius:var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0; }
.code-block pre { margin:0 !important; padding:16px; overflow-x:auto; white-space:pre-wrap;
  background:var(--dsw-alias-markdown-code-block); word-break:break-all;
  border-radius:0 0 var(--dsw-radius-lg) var(--dsw-radius-lg); }
.code-block .line::before { position:absolute; inset-inline-start:0; width:2.5em;
  color:var(--dsw-alias-label-tertiary); text-align:end; content:counter(source-line); user-select:none; }
```

行内代码：`radius-sm`、`.5px` 描边 `border-l1`、背景 `--dsw-alias-markdown-inline-code`、`padding:0 5px`、字号 `0.875em`、`box-decoration-break:clone`（换行处圆角不被切断）。

**终端块**单独一套：`radius-lg`、左侧 30px 沟槽放运行状态点、头部 `max-height:150px` 可滚动、有输出时头部与正文之间 `.5px` 分隔。

**diff 行**：新增行背景 `--dsw-alias-code-diff-added`（绿色 8%/12% 透明）+ `inset 3px 0 0` 左侧绿条 + `+ ` 前缀；删除行对应红色。

### 5.8 列表项（菜单项 / 会话项）

```css
.menu-item { display:flex; align-items:center; gap:6px; width:100%; min-height:34px;
  padding:6px 8px; border:none; border-radius:var(--dsw-radius-md); background:transparent;
  font-size:13px; line-height:20px; color:var(--dsw-alias-label-primary); text-align:left; cursor:pointer; }
.menu-item:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.menu-item:focus-visible:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); outline:none; }
```

菜单列表项**最小高 34px、内距 6/8、圆角 12px、13px 字**，hover 只换底色不加描边；禁用项 `opacity` 降级。折叠列表另有 `compact` 变体（`radius-sm`、更紧的内距）。

### 5.9 滚动条

5px 宽的胶囊细条，无轨道、无边框：

```css
::-webkit-scrollbar { width:5px; height:5px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { border-radius:999px; corner-shape:round;
  background:var(--dsh-scrollbar-thumb); background-clip:content-box; }
::-webkit-scrollbar-thumb:hover { background-color:var(--dsh-scrollbar-thumb-hover); }
```

局部容器可以改写 `--dsh-scrollbar-thumb` 用 l2 档颜色（如代码块、浮动面板），滚动容器普遍用 `scrollbar-gutter:stable` 防抖动。

### 5.10 焦点环

```css
:focus-visible { outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-width: var(--dsw-focus-ring-width); }   /* 2px，颜色＝业务蓝 */
html[data-input-modality=pointer] body :focus-visible:not(:read-write) {
  --dsw-focus-ring-color: transparent; outline-color: transparent; }  /* 鼠标操作时不显示焦点环 */
```

这是「按输入模态决定是否显示」的做法：只有键盘/程序化聚焦才出环。具体组件里的写法是 `outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`，外扩 `outline-offset` 取 1–3px（小控件取负值内收）。

### 5.11 其它已抄到的小元件

- **Tag**：`radius:999px`、`padding:1px 8px`、`11px/17px`、字重 500；7 个 tone：`outline`（描边+三级文字）、`solid`（反白）、`neutral`、`quiet`、`success`/`info`/`warning`/`danger`（`color-mix(in srgb, 状态色 10~12%, transparent)` 作底 + 状态色作字）。
- **状态 pill**：`height:24px; padding:0 8px; radius:999px; 12px/18px`，底 `bg-layer-2`，文字二级色。
- **开关**：`36×20`、`padding:2px`、胶囊；关是 `border-l3`，开是 `brand-primary`；滑块 `16×16` 圆形，`transform .12s ease` 平移 16px。
- **复选框**：`16×16`、`accent-color: var(--dsw-alias-brand-primary)`（直接用原生控件着色）。
- **Markdown**：`hr` 是 `.5px` 的 `border-l2`、上下 32px；`blockquote` 左 2px `label-caption` + 左内距 14px；`li` 之间 6px 间距；表格可横向滚动并带渐隐遮罩。

### 5.12 代码高亮配色（shiki）

DSH 不走 shiki 的默认主题，而是把 11 个语法 token 映射到自己的调色板（`shiki.css` 全文就是这个映射）：

```css
:root {
  --shiki-foreground: var(--dsw-alias-label-primary);
  --shiki-background: var(--dsw-alias-markdown-code-block);
  --shiki-token-constant: #1c7ed6;
  --shiki-token-string: #2f9e44;
  --shiki-token-comment: #868e96;
  --shiki-token-keyword: #d6336c;
  --shiki-token-parameter: #e8590c;
  --shiki-token-function: #6741d9;
  --shiki-token-string-expression: #2b8a3e;
  --shiki-token-punctuation: #495057;
  --shiki-token-link: #1971c2;
}
body[data-ds-dark-theme] {
  --shiki-token-constant: #4dabf7;
  --shiki-token-string: #69db7c;
  --shiki-token-comment: #adb5bd;
  --shiki-token-keyword: #faa2c1;
  --shiki-token-parameter: #ffa94d;
  --shiki-token-function: #b197fc;
  --shiki-token-string-expression: #8ce99a;
  --shiki-token-punctuation: #ced4da;
  --shiki-token-link: #74c0fc;
}
```

| token | 浅色 | 深色 |
| --- | --- | --- |
| constant | `#1c7ed6` | `#4dabf7` |
| string | `#2f9e44` | `#69db7c` |
| comment | `#868e96` | `#adb5bd` |
| keyword | `#d6336c` | `#faa2c1` |
| parameter | `#e8590c` | `#ffa94d` |
| function | `#6741d9` | `#b197fc` |
| string-expression | `#2b8a3e` | `#8ce99a` |
| punctuation | `#495057` | `#ced4da` |
| link | `#1971c2` | `#74c0fc` |

注意浅色和深色是**两套完全不同的色相**（不是同一色相的明暗变化），深色档整体提亮并偏粉/紫，所以照抄时两套都要带上。

## 6. 布局骨架

### 6.1 应用外框（`ui-layout` 的列宽契约，来自源码常量）

```ts
const SIDEBAR_AUTO_COLLAPSE = 1024;   // 视口窄于此，侧边栏自动收成 rail
const RIGHTBAR_MAX_RATIO  = 0.7;      // 右栏最大占视口 70%
const RIGHTBAR_DEFAULT_RATIO = 0.45;  // 右栏首次打开占 45%
// 侧边栏：默认 280，可拖 264–420；收起后 rail 宽 56（macOS / 自绘标题栏时为 0）
// 右栏：最小 300，最大 min(视口*0.7)，剩余空间不足 300 时整列移除
```

外框是 `display:grid`，两行（`minmax(0,1fr) auto`，第二行是底部状态行），列由 JS 实时算成 `sidebar / center / rightbar` 三栏；动画只做在 `grid-template-columns` 上：

```css
.frame { display:grid; grid-template-rows:minmax(0,1fr) auto; height:100%; position:relative;
  overflow:hidden; background:var(--dsw-alias-bg-base); }
.frame[data-animating] { transition:grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.frame[data-dragging]  { transition:none; }
```

列间分界用 `.5px solid var(--dsw-alias-border-l3)` 的 `border-right`；Windows 自绘标题栏时，外框顶部留出 `--dsh-windows-titlebar-height`，中栏左上角用 `16px` 圆角（`corner-shape:round`）露出侧边栏底色，形成「窗口内嵌卡片」的观感。macOS 下工具栏按钮位置有 `--dsh-frame-leading-clearance`（展开 0 / 收起 160px，全屏收起 84px）等一串预留变量。

### 6.2 会话页

- **页头**：`min-height:76px`、`padding:10px 28px 0 20px`、底部 `.5px border-l3`、内部 `grid-template-columns:auto minmax(0,1fr)`；没有标签页时 `min-height:0; padding-bottom:10px`。标题行最小高 30px。
- **内容列**：`max-width: var(--dsh-chat-content-width)`、`margin:0 auto`；宽度计算 `clamp` 等价式是 **`max(680, min(column × 0.64, 920))`**，用户手动拖动过的偏好最小 640，且预留两侧各 88px（`CONTENT_EDGE_BUDGET = 176`）给拖拽把手。
- **消息流滚动区**：`padding:16px calc(side-clearance + 16px)`，`side-clearance` 16px（嵌入模式 8px），`scrollbar-gutter:stable`、`margin-right:2px`。
- **消息间距**：默认 `--dsh-chat-flow-gap: 6px`；助手回复之后 12px；`turn-process` 前后 16px；运行中（streaming）12px。相邻条目用 `margin-top` 而不是 `gap`，并带 `.16s cubic-bezier(.4,0,.2,1)` 过渡以配合折叠展开。
- **输入区**：外层左右留 `--dsh-composer-side-clearance`（16px）、底部 4px；卡片最大宽 = 内容宽 + 32px（嵌入模式封顶 952px）；卡片内部 `gap:12px`；底部叠一层从透明到 `bg-base` 的 36px 渐隐，让滚动内容在输入框后面淡出。

## 7. 动效

全局只有三个时长 token 和一个缓动：

```css
--ds-transition-duration: .2s;       /* 默认 */
--ds-transition-duration-fast: .1s;
--ds-transition-duration-slow: .3s;  /* 布局列宽动画 */
--ds-ease-in-out: cubic-bezier(.4, 0, .2, 1);
```

组件里还散落了几个「手感值」（源码直写，非 token）：

| 场景 | 时长 / 缓动 |
| --- | --- |
| 开关滑块 | `.12s ease` |
| 分段控件滑块 | `.16s ease` |
| 标签页指示器 | `.18s ease` |
| 消息间距变化 | `.16s cubic-bezier(.4,0,.2,1)` |
| Toast 入场 | `.16s ease-out`（+ 上移 6px） |
| Tooltip 入场 | `.15s var(--ds-ease-in-out)`（仅透明度） |
| 对话框 / 遮罩 | `.2s var(--ds-ease-in-out)`（仅透明度） |
| 主题切换 | `.2s`（颜色过渡） |

规律：**只动 opacity 和 transform，不动布局尺寸**；唯一例外是布局栏宽和消息间距，且都显式提供 `data-dragging` / `data-input-fold` 状态下关闭过渡。所有动画都有 `@media (prefers-reduced-motion: reduce) { transition/animation: none }` 兜底。

## 8. 不确定与未找到

1. **左侧边栏「会话/项目」导航项的组件 CSS 没定位到**。`--dsw-specific-sidebar-nav-item-active/-hover/-active-accent` 三个变量确实定义了，但消费它们的 CSS 不在我提取的 `ui-layout / ui-sidebar / ui-session / ui-workspace / ui-chat / ui-conversation` 产物里（可能属于另一个插件或运行期生成）。上文的导航项样式是**按这几个变量反推的用法，未校验**。
2. **危险按钮变体没有公开的单一选择器**。红字/红底的组合是我从 `interactive-bg-hover-danger` 与 `state-error-primary` 的用法归纳（标注为推断）。
3. **字号阶梯的 m-18 名实不符**：`--dsw-font-m-18` 实际是 `16px/28px`，不是 18px。这是源码 bug 级命名漂移，我照抄未改，前端复刻时建议直接按像素值建自己的命名。
4. **没有 spacing token 体系**。我已经用「出现频率」列出事实上的间距阶梯（4/8/12/16 骨架 + 6/10/14/20/28 特殊值），但这是归纳而非抄录，若要求严格一致，请以各组件实际 padding 为准。
5. **语法高亮只覆盖了 shiki 的 9 个颜色 token**（见 5.12）。`--shiki-token-*` 一共 9 个颜色 + 前景/背景 2 个，已全部抄录；但若换用 highlight.js / Prism 等其它高亮器，token 名与语义对不上，需要另做映射。
6. **字体文件本身未提取**（`brand-font.css` 只声明了 Montserrat，字体二进制在 asar 外部资源里），中文实际渲染依赖系统字体。
7. **图标系统**（SVG sprite、尺寸、描边宽度）未涉及：DSH 图标看起来是内联 SVG，规格不统一，无法给出单一规范值。
8. **未做的事**：没有渲染截图比对各值，所有数值来自源码静态读取，运行时被 JS 覆盖的个别内联样式（如拖拽时的宽度、`--dsh-*` 动态变量）未逐一验证。
