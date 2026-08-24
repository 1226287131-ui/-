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
    "1:1": ["640x640", "1024x1024", "1440x1440"],
    "2:3": ["544x800", "832x1248", "1184x1760"],
    "3:2": ["800x544", "1248x832", "1760x1184"],
    "3:4": ["576x736", "896x1184", "1248x1664"],
    "4:3": ["736x576", "1184x896", "1664x1248"],
    "9:16": ["480x864", "768x1376", "1088x1920"],
    "16:9": ["864x480", "1376x768", "1920x1088"],
    "21:9": ["992x416", "1568x672", "2208x960"],
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
