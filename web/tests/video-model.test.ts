import { expect, test } from "bun:test";

import { getVideoModelProfile, isCustomVideoModelName, normalizeVideoQualityForModel } from "../src/lib/video-model";

for (const [model, quality, otherQuality] of [
    ["video-v2-720P（按秒计费）", "720p", "480p"],
    ["video-v2-480P（按秒计费）", "480p", "720p"],
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
