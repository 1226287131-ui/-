export type VideoModelKind = "video-v1" | "video-v2" | "video-v2-full" | "grok" | "generic";

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

const GROK_PROFILE: VideoModelProfile = {
    kind: "grok",
    seconds: [6, 10, 12, 16, 20],
    ratios: ["16:9", "9:16"],
    maxImages: 7,
    maxVideos: 0,
    maxAudios: 0,
    imageMaxBytes: 20 * 1024 * 1024,
    videoMaxBytes: 0,
    audioMaxBytes: 0,
    resolution: "fixed",
    qualityOptions: ["high"],
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
    const value = model.trim().toLowerCase();
    if (value.includes("video-v1")) return VIDEO_V1_PROFILE;
    if (value === "video-v2-满血兜底版") return VIDEO_V2_FULL_PROFILE;
    if (value.includes("video-v2")) return VIDEO_V2_PROFILE;
    if (value.includes("grok-imagine-1.5-video")) return GROK_PROFILE;
    return GENERIC_PROFILE;
}

export function normalizeVideoSecondsForModel(model: string, value: string | number) {
    const profile = getVideoModelProfile(model);
    const requested = Number(value);
    if (Number.isFinite(requested) && profile.seconds.includes(Math.floor(requested))) return String(Math.floor(requested));
    const fallback = profile.seconds[0] || 6;
    return String(fallback);
}

export function normalizeVideoRatioForModel(model: string, value: string) {
    const profile = getVideoModelProfile(model);
    if (profile.ratios.includes(value)) return value;
    const match = String(value || "").match(/^(\d+)x(\d+)$/);
    if (match) {
        const ratio = Number(match[1]) / Number(match[2]);
        return profile.ratios.reduce((best, item) => {
            const [width, height] = item.split(":").map(Number);
            return Math.abs(width / height - ratio) < Math.abs(best.ratio - ratio) ? { item, ratio: width / height } : best;
        }, { item: profile.ratios[0] || "16:9", ratio: 16 / 9 }).item;
    }
    return profile.ratios[0] || "16:9";
}

export function normalizeVideoSizeForModel(model: string, value: string) {
    const profile = getVideoModelProfile(model);
    if (profile.kind === "grok") return value === "720x1280" ? "720x1280" : "1280x720";
    return normalizeVideoRatioForModel(model, value);
}

export function normalizeVideoQualityForModel(model: string, value: string) {
    const profile = getVideoModelProfile(model);
    if (profile.kind === "video-v1") return "720p";
    if (profile.kind === "video-v2-full") return "720p";
    if (profile.kind === "grok") return "high";
    if (profile.kind === "video-v2") {
        const normalized = String(value || "").trim().toLowerCase().replace(/p$/, "");
        return ["480", "720", "1080"].includes(normalized) ? `${normalized}p` : "720p";
    }
    return value;
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
    return kind === "video-v1" || kind === "video-v2" || kind === "video-v2-full";
}
