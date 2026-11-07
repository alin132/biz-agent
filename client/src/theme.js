/**
 * 主题 token —— 对齐 AgentOne 的设计语言。
 *
 * 为什么单独一个文件：颜色/圆角/阴影散落在各组件里，改一次品牌色要翻几十个文件。
 * 这里定义一次，组件只引用 CSS 变量；Naive UI 的组件走 themeOverrides，原生元素走 CSS 变量，两边同源。
 */

/** 品牌主色：靛蓝 → 紫的渐变，AgentOne 的主视觉 */
export const brand = {
	primary: "#6366F1",
	primaryHover: "#4F46E5",
	primaryActive: "#4338CA",
	gradient: "linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%)",
	/** 主色的浅色底：选中项背景、标签底色 */
	soft: "#EEF2FF",
	softBorder: "#C7D2FE",
};

/** 功能色：和主色拉开，避免"什么都是紫的" */
export const semantic = {
	success: "#10B981",
	successSoft: "#ECFDF5",
	warning: "#F59E0B",
	warningSoft: "#FFFBEB",
	danger: "#EF4444",
	dangerSoft: "#FEF2F2",
	info: "#3B82F6",
	infoSoft: "#EFF6FF",
};

/** 中性色阶：文字三级 + 边框 + 背景 */
export const neutral = {
	text: "#1F2937",
	textSecondary: "#5B6472",
	muted: "#66758B",
	line: "#E8EBF0",
	lineStrong: "#D6DBE4",
	/** 页面底：比卡片灰一档，卡片才浮得起来 */
	bg: "#F5F6FA",
	surface: "#FFFFFF",
	surfaceAlt: "#FAFBFD",
};

/** 圆角与阴影：AgentOne 是大圆角 + 极轻阴影 */
export const shape = {
	radiusSm: "8px",
	radius: "12px",
	radiusLg: "16px",
	shadowSm: "0 1px 2px rgba(16, 24, 40, 0.04)",
	shadow: "0 2px 8px rgba(16, 24, 40, 0.06)",
	shadowLg: "0 8px 24px rgba(16, 24, 40, 0.08)",
};

/** Naive UI 的 themeOverrides：让 n-button / n-card / n-input 一进来就穿对衣服 */
export const themeOverrides = {
	common: {
		primaryColor: brand.primary,
		primaryColorHover: brand.primaryHover,
		primaryColorPressed: brand.primaryActive,
		primaryColorSuppl: brand.primaryHover,
		successColor: semantic.success,
		warningColor: semantic.warning,
		errorColor: semantic.danger,
		infoColor: semantic.info,
		textColorBase: neutral.text,
		textColor1: neutral.text,
		textColor2: neutral.textSecondary,
		textColor3: neutral.muted,
		borderColor: neutral.line,
		dividerColor: neutral.line,
		bodyColor: neutral.bg,
		cardColor: neutral.surface,
		borderRadius: shape.radius,
		borderRadiusSmall: shape.radiusSm,
		fontFamily:
			'-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
		fontSize: "14px",
	},
	Card: {
		borderRadius: shape.radiusLg,
		paddingMedium: "20px 24px",
	},
	Button: {
		borderRadiusMedium: shape.radiusSm,
		fontWeightStrong: "500",
	},
	Input: {
		borderRadius: shape.radiusSm,
	},
	Tag: {
		borderRadius: "999px",
	},
	Menu: {
		borderRadius: shape.radiusSm,
		itemHeight: "40px",
	},
};

/** 把 token 写成 CSS 变量，原生元素（非 Naive 组件）也能用同一套颜色 */
export function applyCssVariables() {
	const root = document.documentElement;
	const vars = {
		"--brand-primary": brand.primary,
		"--brand-primary-hover": brand.primaryHover,
		"--brand-gradient": brand.gradient,
		"--brand-soft": brand.soft,
		"--brand-soft-border": brand.softBorder,
		"--success": semantic.success,
		"--success-soft": semantic.successSoft,
		"--warning": semantic.warning,
		"--warning-soft": semantic.warningSoft,
		"--danger": semantic.danger,
		"--danger-soft": semantic.dangerSoft,
		"--info": semantic.info,
		"--info-soft": semantic.infoSoft,
		"--text": neutral.text,
		"--text-2": neutral.textSecondary,
		"--muted": neutral.muted,
		"--line": neutral.line,
		"--line-strong": neutral.lineStrong,
		"--bg": neutral.bg,
		"--surface": neutral.surface,
		"--surface-alt": neutral.surfaceAlt,
		"--radius-sm": shape.radiusSm,
		"--radius": shape.radius,
		"--radius-lg": shape.radiusLg,
		"--shadow-sm": shape.shadowSm,
		"--shadow": shape.shadow,
		"--shadow-lg": shape.shadowLg,
	};
	for (const [key, value] of Object.entries(vars)) {
		root.style.setProperty(key, value);
	}
}
