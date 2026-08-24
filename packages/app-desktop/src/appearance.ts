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

const LIGHT_ACCENT_MIN_CONTRAST = 3.75;
const LIGHT_ACCENT_MAX_SATURATION = 0.75;

function rgbToHsl(channels: readonly [number, number, number]): [number, number, number] {
  const red = channels[0] / 255;
  const green = channels[1] / 255;
  const blue = channels[2] / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const lightness = (max + min) / 2;

  if (delta === 0) return [0, 0, lightness];

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === red) {
    hue = 60 * (((green - blue) / delta) % 6);
  } else if (max === green) {
    hue = 60 * ((blue - red) / delta + 2);
  } else {
    hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;

  return [hue, saturation, lightness];
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const huePrime = hue / 60;
  const second = chroma * (1 - Math.abs((huePrime % 2) - 1));
  const match = lightness - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (huePrime < 1) {
    [red, green, blue] = [chroma, second, 0];
  } else if (huePrime < 2) {
    [red, green, blue] = [second, chroma, 0];
  } else if (huePrime < 3) {
    [red, green, blue] = [0, chroma, second];
  } else if (huePrime < 4) {
    [red, green, blue] = [0, second, chroma];
  } else if (huePrime < 5) {
    [red, green, blue] = [second, 0, chroma];
  } else {
    [red, green, blue] = [chroma, 0, second];
  }

  return [red, green, blue].map((channel) => Math.round((channel + match) * 255)) as [
    number,
    number,
    number,
  ];
}

function deriveLightAccentChannels(channels: readonly [number, number, number]): [number, number, number] {
  if (contrastRatio(relativeLuminance(...channels), 1) >= LIGHT_ACCENT_MIN_CONTRAST) {
    return [...channels];
  }

  const [hue, sourceSaturation, sourceLightness] = rgbToHsl(channels);
  const saturation = Math.min(sourceSaturation, LIGHT_ACCENT_MAX_SATURATION);
  let lowerLightness = 0;
  let upperLightness = sourceLightness;

  // Find the lightest same-hue color that clears the white-background UI threshold.
  for (let iteration = 0; iteration < 14; iteration += 1) {
    const lightness = (lowerLightness + upperLightness) / 2;
    const candidate = hslToRgb(hue, saturation, lightness);
    if (contrastRatio(relativeLuminance(...candidate), 1) >= LIGHT_ACCENT_MIN_CONTRAST) {
      lowerLightness = lightness;
    } else {
      upperLightness = lightness;
    }
  }

  return hslToRgb(hue, saturation, lowerLightness);
}

export function deriveAccentTokens(color: string, theme: Theme): AccentTokens {
  const normalized = normalizeAccentColor(color) ?? DEFAULT_ACCENT_COLOR;
  const sourceChannels: [number, number, number] = [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
  const channels = theme === "light" ? deriveLightAccentChannels(sourceChannels) : sourceChannels;
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
    accent: theme === "dark" ? normalized : toHex(channels),
    accentStrong,
    accentDim: `rgba(${red}, ${green}, ${blue}, ${alpha})`,
    accentGlow: `rgba(${red}, ${green}, ${blue}, ${glowAlpha})`,
    accentForeground: blackContrast >= whiteContrast ? "#000000" : "#FFFFFF",
  };
}
