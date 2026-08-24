export type Theme = "dark" | "light";

export const DEFAULT_ACCENT_COLOR = "#B8A2FF";

export const ACCENT_PRESETS = [
  { id: "lavender", label: "薰衣草紫", color: "#B8A2FF" },
  { id: "sky", label: "天空蓝", color: "#7CA7FF" },
  { id: "mint", label: "薄荷绿", color: "#66C7A5" },
  { id: "peach", label: "蜜桃橙", color: "#F0A36A" },
  { id: "rose", label: "玫瑰粉", color: "#E58BA8" },
] as const;

export interface AccentTokens {
  accent: string;
  accentStrong: string;
  accentDim: string;
  accentGlow: string;
  accentForeground: string;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeAccentColor(value: string): string | null {
  if (!HEX_COLOR.test(value)) return null;
  const hex = value.slice(1);
  const expanded =
    hex.length === 3
      ? hex
          .split("")
          .map((channel) => channel + channel)
          .join("")
      : hex;
  return `#${expanded.toUpperCase()}`;
}

function mixChannel(channel: number, target: number, amount: number): number {
  return Math.round(channel + (target - channel) * amount);
}

function toHex(channels: readonly [number, number, number]): string {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function relativeLuminance(red: number, green: number, blue: number): number {
  const toLinear = (channel: number): number => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue);
}

function contrastRatio(firstLuminance: number, secondLuminance: number): number {
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function deriveAccentTokens(color: string, theme: Theme): AccentTokens {
  const accent = normalizeAccentColor(color) ?? DEFAULT_ACCENT_COLOR;
  const channels: [number, number, number] = [
    Number.parseInt(accent.slice(1, 3), 16),
    Number.parseInt(accent.slice(3, 5), 16),
    Number.parseInt(accent.slice(5, 7), 16),
  ];
  const [red, green, blue] = channels;
  const amount = 0.18;
  const accentStrong = toHex(
    channels.map((channel) => mixChannel(channel, theme === "dark" ? 255 : 0, amount)) as [
      number,
      number,
      number,
    ],
  );
  const alpha = theme === "dark" ? 0.14 : 0.1;
  const glowAlpha = theme === "dark" ? 0.35 : 0.25;
  const luminance = relativeLuminance(red, green, blue);
  const blackContrast = contrastRatio(luminance, 0);
  const whiteContrast = contrastRatio(luminance, 1);

  return {
    accent,
    accentStrong,
    accentDim: `rgba(${red}, ${green}, ${blue}, ${alpha})`,
    accentGlow: `rgba(${red}, ${green}, ${blue}, ${glowAlpha})`,
    accentForeground: blackContrast >= whiteContrast ? "#000000" : "#FFFFFF",
  };
}
