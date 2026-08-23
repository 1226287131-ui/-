export type VideoModelKind = "video-v1" | "video-v2" | "video-v2-full" | "video-v3" | "grok" | "minimax-h3" | "generic";

export type VideoModelProfile = {
    kind: VideoModelKind;
    seconds: readonly number[];
    ratios: readonly string[];
    maxImages: number;
    maxVideos: number;
    maxAudios: number;
    imageMaxBytes: number;
    videoMaxBytes: number;
    audioMaxBytes: number;
    resolution: "fixed" | "selectable" | "quality";
    qualityOptions: readonly string[];
    /** Fixed pixel sizes used by models whose API does not accept aspect ratios. */
    sizes?: readonly string[];
    defaultSize?: string;
    defaultRatio?: string;
};

const VIDEO_V1_PROFILE: VideoModelProfile = {
    kind: "video-v1",
    seconds: [5, 10, 15],
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    maxImages: 9,
    maxVideos: 0,
    maxAudios: 0,
    imageMaxBytes: 12 * 1024 * 1024,
    videoMaxBytes: 0,
    audioMaxBytes: 0,
    resolution: "fixed",
    qualityOptions: ["720p"],
};

const VIDEO_V2_PROFILE: VideoModelProfile = {
    kind: "video-v2",
    seconds: [5, 10, 15],
    ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
    imageMaxBytes: 12 * 1024 * 1024,
    videoMaxBytes: 48 * 1024 * 1024,
    audioMaxBytes: 16 * 1024 * 1024,
    resolution: "selectable",
    qualityOptions: ["480p", "720p", "1080p"],
};

const VIDEO_V2_FULL_PROFILE: VideoModelProfile = {
    kind: "video-v2-full",
    seconds: [15],
    ratios: ["16:9", "9:16"],
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
    imageMaxBytes: 12 * 1024 * 1024,
    videoMaxBytes: 48 * 1024 * 1024,
    audioMaxBytes: 16 * 1024 * 1024,
    resolution: "fixed",
    qualityOptions: ["720p"],
};

const VIDEO_V3_PROFILE: VideoModelProfile = {
    kind: "video-v3",
    seconds: Array.from({ length: 27 }, (_, index) => index + 4),
    ratios: ["16:9", "1:1", "9:16"],
    defaultRatio: "16:9",
    maxImages: 30,
    maxVideos: 10,
    maxAudios: 10,
    imageMaxBytes: 20 * 1024 * 1024,
    videoMaxBytes: Number.POSITIVE_INFINITY,
    audioMaxBytes: Number.POSITIVE_INFINITY,
    resolution: "selectable",
    qualityOptions: ["480p", "720p"],
};

const GROK_PROFILE: VideoModelProfile = {
    kind: "grok",
    seconds: Array.from({ length: 15 }, (_, index) => index + 1),
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "2:3", "3:2"],
    maxImages: Number.POSITIVE_INFINITY,
    maxVideos: 0,
    maxAudios: 0,
    imageMaxBytes: Number.POSITIVE_INFINITY,
    videoMaxBytes: 0,
    audioMaxBytes: 0,
    resolution: "selectable",
    qualityOptions: ["480p", "720p", "1080p"],
};

export const MINIMAX_H3_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"] as const;

export type MiniMaxH3AspectRatio = (typeof MINIMAX_H3_ASPECT_RATIOS)[number];

export const MINIMAX_H3_SIZES_BY_RATIO: Record<MiniMaxH3AspectRatio, readonly string[]> = {
    "1:1": ["448x448", "576x576", "640x640", "736x736", "800x800", "864x864", "928x928", "960x960", "1024x1024", "1024x1024", "1120x1120", "1248x1248", "1376x1376", "1440x1440"],
    "2:3": ["384x576", "448x672", "544x800", "576x896", "640x960", "704x1056", "736x1120", "800x1184", "832x1248", "832x1248", "928x1376", "1024x1536", "1120x1696", "1184x1760"],
    "3:2": ["576x384", "672x448", "800x544", "896x576", "960x640", "1056x704", "1120x736", "1184x800", "1248x832", "1248x832", "1376x928", "1536x1024", "1696x1120", "1760x1184"],
    "3:4": ["384x544", "480x640", "576x736", "640x832", "672x928", "736x992", "800x1056", "832x1120", "864x1184", "896x1184", "960x1280", "1088x1440", "1184x1600", "1248x1664"],
    "4:3": ["544x384", "640x480", "736x576", "832x640", "928x672", "992x736", "1056x800", "1120x832", "1184x864", "1184x896", "1280x960", "1440x1088", "1600x1184", "1664x1248"],
    "9:16": ["352x608", "416x736", "480x864", "544x960", "608x1056", "640x1152", "672x1216", "736x1280", "768x1344", "768x1376", "832x1504", "928x1664", "1024x1824", "1088x1920"],
    "16:9": ["608x352", "736x416", "864x480", "960x544", "1056x608", "1152x640", "1216x672", "1280x736", "1344x768", "1376x768", "1504x832", "1664x928", "1824x1024", "1920x1088"],
    "21:9": ["704x288", "864x352", "992x416", "1120x480", "1216x512", "1312x576", "1408x608", "1472x640", "1536x672", "1568x672", "1728x736", "1920x832", "2112x896", "2208x960"],
};

export const MINIMAX_H3_ALL_SIZES = Array.from(new Set(MINIMAX_H3_ASPECT_RATIOS.flatMap((ratio) => MINIMAX_H3_SIZES_BY_RATIO[ratio])));

export const MINIMAX_H3_WORKFLOW_IDS = [
    "text-to-video",
    "multi-reference",
    "fl2v",
    "cf-multi-reference",
    "cf-fl2v",
    "mj",
    "cf-mj",
] as const;

export type MiniMaxH3WorkflowId = (typeof MINIMAX_H3_WORKFLOW_IDS)[number];
export type MiniMaxH3WorkflowSelection = "auto" | MiniMaxH3WorkflowId;
export type MiniMaxH3WorkflowSize = "2K" | "4K";
export const MINIMAX_H3_WORKFLOW_SIZES = ["2K", "4K"] as const;

export function isMiniMaxH3WorkflowId(value: unknown): value is MiniMaxH3WorkflowId {
    return typeof value === "string" && (MINIMAX_H3_WORKFLOW_IDS as readonly string[]).includes(value);
}

export function isMiniMaxH3WorkflowSize(value: unknown): value is MiniMaxH3WorkflowSize {
    return value === "2K" || value === "4K";
}

export function normalizeMiniMaxH3WorkflowSelection(value: unknown): MiniMaxH3WorkflowSelection {
    return value === "auto" || isMiniMaxH3WorkflowId(value) ? value : "auto";
}

export function normalizeMiniMaxH3WorkflowSize(value: unknown): MiniMaxH3WorkflowSize {
    return isMiniMaxH3WorkflowSize(value) ? value : "2K";
}

export function inferMiniMaxH3WorkflowId(input: { images: number; videos: number; audios: number; firstLastFrame?: boolean }): MiniMaxH3WorkflowId {
    if (input.firstLastFrame) return "fl2v";
    return input.images + input.videos + input.audios > 0 ? "multi-reference" : "text-to-video";
}

export function getMiniMaxH3SizeOptionsForRatio(ratio: string) {
    const normalized = (MINIMAX_H3_ASPECT_RATIOS as readonly string[]).includes(ratio) ? (ratio as MiniMaxH3AspectRatio) : "16:9";
    return Array.from(new Set(MINIMAX_H3_SIZES_BY_RATIO[normalized]));
}

export function getMiniMaxH3AspectRatioForSize(size: string) {
    const match = MINIMAX_H3_ASPECT_RATIOS.find((ratio) => MINIMAX_H3_SIZES_BY_RATIO[ratio].includes(size));
    return match || "16:9";
}

const MINIMAX_H3_PROFILE: VideoModelProfile = {
    kind: "minimax-h3",
    seconds: Array.from({ length: 12 }, (_, index) => index + 4),
    ratios: MINIMAX_H3_ASPECT_RATIOS,
    sizes: MINIMAX_H3_ALL_SIZES,
    defaultSize: "1920x1088",
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
    imageMaxBytes: 64 * 1024 * 1024,
    videoMaxBytes: 64 * 1024 * 1024,
    audioMaxBytes: 64 * 1024 * 1024,
    resolution: "fixed",
    qualityOptions: [],
};

const GENERIC_PROFILE: VideoModelProfile = {
    kind: "generic",
    seconds: [6, 10, 12, 16, 20],
    ratios: ["16:9", "9:16", "1:1"],
    maxImages: 9,
    maxVideos: 3,
    maxAudios: 3,
    imageMaxBytes: 30 * 1024 * 1024,
    videoMaxBytes: 50 * 1024 * 1024,
    audioMaxBytes: 15 * 1024 * 1024,
    resolution: "selectable",
    qualityOptions: [],
};

export function getVideoModelProfile(model: string): VideoModelProfile {
    const raw = model.trim().toLowerCase();
    const separator = raw.lastIndexOf("::");
    const value = separator >= 0 ? raw.slice(separator + 2) : raw;
    if (value.includes("video-v1")) return VIDEO_V1_PROFILE;
    if (value === "video-v2-满血兜底版") return VIDEO_V2_FULL_PROFILE;
    if (value.includes("video-v2")) return VIDEO_V2_PROFILE;
    if (["video-v3", "seedance-2.5", "seedance2.5", "sd-2.5", "sd2.5"].includes(value)) return VIDEO_V3_PROFILE;
    if (value.includes("grok-imagine") && value.includes("video")) return GROK_PROFILE;
    if (value.includes("minimax-h3")) return MINIMAX_H3_PROFILE;
    return GENERIC_PROFILE;
}

export function normalizeVideoSecondsForModel(model: string, value: string | number) {
    const profile = getVideoModelProfile(model);
    const requested = Number(value);
    if (profile.kind === "grok" && Number.isFinite(requested)) return String(Math.min(15, Math.max(1, Math.floor(requested))));
    if (Number.isFinite(requested) && profile.seconds.includes(Math.floor(requested))) return String(Math.floor(requested));
    if (profile.kind === "grok") return "5";
    const fallback = profile.seconds[0] || 6;
    return String(fallback);
}

export function normalizeVideoRatioForModel(model: string, value: string) {
    const profile = getVideoModelProfile(model);
    if (profile.ratios.includes(value)) return value;
    const match = String(value || "").match(/^(\d+)x(\d+)$/);
    if (match) {
        const ratio = Number(match[1]) / Number(match[2]);
        const ratios = profile.ratios
            .filter((item) => /^\d+:\d+$/.test(item))
            .map((item) => {
                const [width, height] = item.split(":").map(Number);
                return { item, ratio: width / height };
            });
        if (ratios.length)
            return ratios.reduce(
            (best, item) => {
                return Math.abs(item.ratio - ratio) < Math.abs(best.ratio - ratio) ? item : best;
            },
            ratios.find((item) => item.item === profile.defaultRatio) || ratios[0],
        ).item;
    }
    return profile.defaultRatio || profile.ratios[0] || "16:9";
}

export function normalizeVideoSizeForModel(model: string, value: string) {
    const profile = getVideoModelProfile(model);
    if (profile.sizes?.length) {
        const requested = String(value || "").trim();
        if (profile.sizes.includes(requested)) return requested;
        const match = requested.match(/^(\d+)[x:](\d+)$/);
        if (match) {
            const requestedRatio = Number(match[1]) / Number(match[2]);
            return profile.sizes.reduce(
                (best, item) => {
                    const [width, height] = item.split("x").map(Number);
                    const ratio = width / height;
                    return Math.abs(ratio - requestedRatio) < Math.abs(best.ratio - requestedRatio) ? { item, ratio } : best;
                },
                { item: profile.defaultSize || profile.sizes[0], ratio: 16 / 9 },
            ).item;
        }
        return profile.defaultSize || profile.sizes[0];
    }
    return normalizeVideoRatioForModel(model, value);
}

export function normalizeVideoQualityForModel(model: string, value: string) {
    const profile = getVideoModelProfile(model);
    if (profile.kind === "video-v1") return "720p";
    if (profile.kind === "video-v2-full") return "720p";
    if (profile.kind === "video-v3") {
        const raw = String(value || "").trim().toLowerCase();
        // "720" is the legacy global default token; QY defaults to 480p.
        if (raw === "720") return "480p";
        const normalized = raw.replace(/p$/, "");
        return normalized === "720" ? "720p" : "480p";
    }
    if (profile.kind === "video-v2" || profile.kind === "grok") {
        const normalized = String(value || "")
            .trim()
            .toLowerCase()
            .replace(/p$/, "");
        return ["480", "720", "1080"].includes(normalized) ? `${normalized}p` : "720p";
    }
    return value;
}

export function normalizeVideoQualityForReferences(model: string, value: string, imageCount = 0) {
    const quality = normalizeVideoQualityForModel(model, value);
    return getVideoModelProfile(model).kind === "grok" && imageCount > 1 && quality === "1080p" ? "720p" : quality;
}

export function normalizeVideoSettingsForModel(model: string, settings: { seconds: string; size: string; quality: string }) {
    const profile = getVideoModelProfile(model);
    if (profile.kind === "generic") return settings;
    return {
        seconds: normalizeVideoSecondsForModel(model, settings.seconds),
        size: normalizeVideoSizeForModel(model, settings.size),
        quality: normalizeVideoQualityForModel(model, settings.quality),
    };
}

export function videoModelSupports(model: string, kind: "image" | "video" | "audio") {
    const profile = getVideoModelProfile(model);
    if (kind === "image") return profile.maxImages > 0;
    if (kind === "video") return profile.maxVideos > 0;
    return profile.maxAudios > 0;
}

export function videoModelUsesPublicMediaUrls(model: string) {
    const kind = getVideoModelProfile(model).kind;
    return kind === "video-v1" || kind === "video-v2" || kind === "video-v2-full" || kind === "video-v3" || kind === "minimax-h3";
}
