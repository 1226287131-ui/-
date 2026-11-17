import { expect, test } from "bun:test";

import { getVideoModelProfile, isCustomVideoModelName, normalizeVideoQualityForModel, normalizeVideoSecondsForModel, videoModelSupports } from "../src/lib/video-model";

for (const [model, quality, otherQuality] of [
    ["video-v2-720P（按秒计费）", "720p", "480p"],
    ["video-v2-480P（按秒计费）", "480p", "720p"],
    ["video-v2-480P（按条计费）", "480p", "720p"],
]) {
    test(`${model} uses V2 limits and fixed resolution`, () => {
        const profile = getVideoModelProfile(model);
        expect(isCustomVideoModelName(model)).toBe(true);
        expect(isCustomVideoModelName(`channel::${model}`)).toBe(true);
        expect(profile.kind).toBe("video-v2");
        expect([profile.maxImages, profile.maxVideos, profile.maxAudios]).toEqual([9, 3, 3]);
        expect([profile.secondsMin, profile.secondsMax]).toEqual([5, 15]);
        expect(profile.resolution).toBe("fixed");
        expect(profile.qualityOptions).toEqual([quality]);
        expect(normalizeVideoQualityForModel(model, otherQuality)).toBe(quality);
        expect(normalizeVideoQualityForModel(`channel::${model}`, otherQuality)).toBe(quality);
    });
}

test("video-v3-特价版 uses V3 reference limits and request settings", () => {
    for (const model of ["video-v3-特价版", "channel::video-v3-特价版"]) {
        const profile = getVideoModelProfile(model);
        expect(isCustomVideoModelName(model)).toBe(true);
        expect(profile.kind).toBe("video-v3");
        expect([profile.maxImages, profile.maxVideos, profile.maxAudios]).toEqual([30, 10, 10]);
        for (const kind of ["image", "video", "audio"] as const) expect(videoModelSupports(model, kind)).toBe(true);
        expect([4, 17, 30].map((seconds) => normalizeVideoSecondsForModel(model, seconds))).toEqual(["4", "17", "30"]);
        expect(normalizeVideoQualityForModel(model, "480p")).toBe("480p");
        expect(normalizeVideoQualityForModel(model, "720p")).toBe("720p");
    }
});

test("muse uses V3 settings with 720p and up to 50 seconds", () => {
    const model = "muse（按秒计费）";
    const profile = getVideoModelProfile(model);
    expect(isCustomVideoModelName(model)).toBe(true);
    expect(profile.kind).toBe("video-v3");
    expect([profile.secondsMin, profile.secondsMax]).toEqual([4, 50]);
    expect([profile.maxImages, profile.maxVideos, profile.maxAudios]).toEqual([30, 10, 10]);
    expect(profile.resolution).toBe("fixed");
    expect(profile.qualityOptions).toEqual(["720p"]);
    expect(normalizeVideoQualityForModel(model, "480p")).toBe("720p");
    expect(normalizeVideoQualityForModel(`channel::${model}`, "1080p")).toBe("720p");
    expect([3, 4, 29, 30, 49, 50, 51].map((seconds) => normalizeVideoSecondsForModel(model, seconds))).toEqual(["4", "4", "29", "30", "49", "50", "50"]);
});

test("video-v3 flash models use V3 settings with their fixed resolution", () => {
    for (const [model, quality] of [["video-v3-flash-480p", "480p"], ["video-v3-flash-720p", "720p"]] as const) {
        const profile = getVideoModelProfile(model);
        expect(isCustomVideoModelName(model)).toBe(true);
        expect(isCustomVideoModelName(`channel::${model}`)).toBe(true);
        expect(profile.kind).toBe("video-v3");
        expect([profile.maxImages, profile.maxVideos, profile.maxAudios]).toEqual([30, 10, 10]);
        expect([profile.secondsMin, profile.secondsMax]).toEqual([4, 30]);
        expect(profile.resolution).toBe("fixed");
        expect(profile.qualityOptions).toEqual([quality]);
        expect(normalizeVideoQualityForModel(model, quality === "480p" ? "720p" : "480p")).toBe(quality);
        expect(normalizeVideoQualityForModel(`channel::${model}`, "1080p")).toBe(quality);
        expect(normalizeVideoSecondsForModel(model, 30)).toBe("30");
    }
});
