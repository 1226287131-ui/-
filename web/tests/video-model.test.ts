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
